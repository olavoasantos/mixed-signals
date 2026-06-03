/**
 * Transferable sidecar support for sync RPC.
 *
 * The sync transport uses two channels: the SAB lane carries the JSON wire
 * envelope (with `@T:'transfer'` sentinels in place of actual Transferable
 * values), and a sidecar `MessagePort` carries the real Transferable objects
 * via `postMessage` with a transfer list (zero-copy ownership transfer).
 *
 * ## Reserved `@T` tag: `transfer`
 *
 * The tag `transfer` is reserved by `mixed-signals/sync` for sidecar
 * transferable references. No collision with shipping codecs.
 *
 * ### Full `@T` tag audit (mixed-signals/codecs):
 *
 *   u      — undefined
 *   ta     — TypedArray / DataView (base64-encoded bytes)
 *   ab     — ArrayBuffer (base64-encoded bytes)
 *   map    — Map (entries array)
 *   set    — Set (values array)
 *   date   — Date (epoch millis)
 *   re     — RegExp (source + flags)
 *   err    — Error (name + message + stack)
 *   url    — URL (href)
 *   bi     — BigInt (string)
 *
 * User codecs MAY use custom `@T` tags; `transfer` is reserved and must
 * not be used by user codecs. This is documented in the public API
 * reference.
 *
 * @internal
 */

import {isTransferable} from '../shared/codec.ts';
import type {WireMessage} from '../shared/protocol.ts';

/** Reserved `@T` tag for sidecar transferable sentinels. */
export const TRANSFER_TAG = 'transfer';

/** Field name for codec-tagged values. */
const TYPE_MARKER = '@T';

/**
 * A sidecar transferable sentinel placed in the SAB wire envelope
 * where a `Transferable` value was found. The actual value travels
 * over the sidecar `MessagePort`.
 */
export interface TransferSentinel {
  '@T': 'transfer';
  id: number;
}

/** A collected transferable with its batch-scoped id. */
export interface CollectedTransferable {
  id: number;
  value: Transferable;
}

/** Message shape posted on the sidecar `MessagePort`. */
export interface SidecarMessage {
  seq: number;
  id: number;
  value: Transferable;
}

/**
 * Type guard: is this object a transfer sentinel?
 */
export function isTransferSentinel(v: unknown): v is TransferSentinel {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as Record<string, unknown>)[TYPE_MARKER] === TRANSFER_TAG &&
    typeof (v as Record<string, unknown>).id === 'number'
  );
}

/**
 * Walk a `WireMessage[]` batch (already brand-substituted) and replace
 * every `Transferable` value with a `{@T:'transfer', id:N}` sentinel.
 * Returns the sentinel-substituted calls and the per-batch transferable
 * list. IDs are monotonic starting at 1, unique within the batch.
 *
 * The walker handles nested Transferables (e.g., an object containing
 * an ArrayBuffer field). Non-Transferable values pass through unchanged.
 */
export function collectAndReplaceSyncTransferables(calls: WireMessage[]): {
  calls: WireMessage[];
  transferables: CollectedTransferable[];
} {
  let nextId = 1;
  const transferables: CollectedTransferable[] = [];

  function walkValue(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    if (isTransferable(v)) {
      const id = nextId++;
      transferables.push({id, value: v as Transferable});
      return {[TYPE_MARKER]: TRANSFER_TAG, id} satisfies TransferSentinel;
    }
    if (Array.isArray(v)) {
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        out[i] = walkValue(v[i]);
      }
      return out;
    }
    // Walk plain objects only. Class instances, codec-tagged objects
    // (`{@T: 'map', d: [...]}`) etc. pass through — their children
    // may contain transferables but the codec has already encoded
    // them (e.g., ArrayBuffer inside a Map → base64 in the codec
    // output). Only plain-object wrappers around raw transferables
    // need sentinel substitution.
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== Object.prototype) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = walkValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }

  const result: WireMessage[] = calls.map((call) => ({
    ...call,
    params: call.params
      ? (walkValue(call.params) as unknown[])
      : call.params,
  }));

  return {calls: result, transferables};
}

/**
 * Scan a `WireMessage[]` batch for `@T:'transfer'` sentinels and
 * collect the set of expected transferable ids.
 */
export function collectExpectedTransferIds(
  calls: Array<{method: string; params?: unknown[]}>,
): Set<number> {
  const ids = new Set<number>();

  function walk(v: unknown): void {
    if (v === null || v === undefined || typeof v !== 'object') return;
    if (isTransferSentinel(v)) {
      ids.add(v.id);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== Object.prototype) return;
    for (const k of Object.keys(v as Record<string, unknown>)) {
      walk((v as Record<string, unknown>)[k]);
    }
  }

  for (const call of calls) {
    if (call.params) walk(call.params);
  }
  return ids;
}

/**
 * Reconstruct a `calls` array by replacing `@T:'transfer'` sentinels
 * with actual values from the transferable buffer.
 */
export function reconstructTransferables(
  calls: Array<{method: string; params?: unknown[]}>,
  buffer: Map<number, unknown>,
): Array<{method: string; params?: unknown[]}> {
  function walkValue(v: unknown): unknown {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (isTransferSentinel(v)) {
      return buffer.get(v.id) ?? v;
    }
    if (Array.isArray(v)) {
      return v.map(walkValue);
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== Object.prototype) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = walkValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }

  return calls.map((call) => ({
    ...call,
    params: call.params
      ? (walkValue(call.params) as unknown[])
      : call.params,
  }));
}

/**
 * Scan a value for `Transferable` instances. Returns the first one found
 * (with its path expression), or `null` if none exist.
 *
 * Used by the response-side guardrail to detect transferable returns
 * before they silently corrupt to `{}` during JSON serialization.
 *
 * Cost: one structural walk per response value. Negligible for typical
 * return shapes (a few hundred nanoseconds).
 */
export function findTransferableInValue(
  value: unknown,
  path = '',
): {type: string; path: string} | null {
  if (value === null || value === undefined || typeof value !== 'object')
    return null;
  if (isTransferable(value)) {
    const typeName = (value as {constructor?: {name?: string}}).constructor
      ?.name ?? 'Transferable';
    return {type: typeName, path: path || '(root)'};
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findTransferableInValue(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return null;
  for (const k of Object.keys(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k;
    const found = findTransferableInValue(
      (value as Record<string, unknown>)[k],
      childPath,
    );
    if (found) return found;
  }
  return null;
}

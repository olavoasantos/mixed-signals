/**
 * Lifecycle-owner protocol module for worker teardown.
 *
 * Centralizes the two-step death notification used by every spawner
 * topology (iframe relay, iframe broker, Node `worker_threads`):
 *
 *   1. Atomically store `CALLER_STATE = DEAD` in the control SAB.
 *   2. Send `{__sync: 'client_dead', epoch, clientId}` via the
 *      host-facing transport.
 *
 * The SAB store happens first so the host's chunk-publish polls see
 * DEAD immediately, even if the postMessage delivery is delayed.
 *
 * Idempotent: calling twice for the same bridge is harmless — the
 * SAB store is a no-op write (still DEAD) and the second postMessage
 * fires (the host dedups via epoch).
 *
 * Internal-only — never exposed through `sync/index.ts`. Detection
 * sites import directly.
 */

import type {RawTransport} from '../shared/protocol.ts';
import {CALLER_STATE, CTRL} from './lane.ts';

/**
 * Mark a caller as dead. Called by lifecycle owners (iframe relay,
 * iframe broker, Node worker bridge) when they detect the worker has
 * died or become unreachable.
 *
 * @param opts.controlSab - The control SharedArrayBuffer for this lane.
 * @param opts.hostTransport - Transport facing the host (parent context).
 * @param opts.epoch - Handshake epoch for staleness validation.
 * @param opts.clientId - Unique client identifier for dedup.
 */
export function markCallerDead(opts: {
  controlSab: SharedArrayBuffer;
  hostTransport: RawTransport;
  epoch: number;
  clientId: string;
}): void {
  const {controlSab, hostTransport, epoch, clientId} = opts;

  // Step 1: SAB store first — the host's chunk-publish poll checks
  // this before each write, so it sees DEAD even if the postMessage
  // is delayed or lost.
  try {
    const view = new Int32Array(controlSab);
    Atomics.store(view, CTRL.CALLER_STATE, CALLER_STATE.DEAD);
  } catch (err) {
    // SAB may be detached or GC'd under heavy memory pressure.
    // The lifecycle owner has already decided death happened;
    // swallow and continue to the notification.
    // eslint-disable-next-line no-console
    console.warn('[mixed-signals/sync] markCallerDead: SAB store failed', err);
  }

  // Step 2: Send the client_dead notification envelope.
  try {
    hostTransport.send({__sync: 'client_dead', epoch, clientId});
  } catch (err) {
    // Transport may already be disposed. The SAB store (step 1)
    // is the primary signal; the notification is a courtesy.
    // The host's chunk poll will still detect death.
    // eslint-disable-next-line no-console
    console.warn('[mixed-signals/sync] markCallerDead: transport send failed', err);
  }
}

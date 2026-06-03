import type {RawTransport, TransportContext} from '../shared/protocol.ts';
import {SyncRPCIframeBridgeError} from './errors.ts';
import type {IframeBrokerBridge} from './iframe-bridge.ts';
import {markCallerDead} from './lifecycle.ts';
import {enableSyncServer} from './server.ts';

/**
 * Minimal `Worker`-shaped surface used by the broker. Extracted so
 * tests can pass a stub without a full DOM `Worker`.
 *
 * @internal
 */
type WorkerLike = {
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
  addEventListener(type: string, cb: (event: any) => void): void;
  removeEventListener(type: string, cb: (event: any) => void): void;
};

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * Cross-origin iframe active broker.
 *
 * Runs on the iframe's main thread when the iframe and its parent
 * are in different origins (the canonical Shopify-extension shape:
 * host page + CDN-served iframe + extension worker). The broker
 * bridges two transports:
 *
 *   - **Downward (sync)**: the iframe ↔ worker leg. SABs are
 *     allocated inside the iframe's agent cluster and transferred
 *     to the same-origin worker at handshake time;
 *     `enableSyncServer` runs internally and drives the six-state
 *     chunk machine + capture window.
 *   - **Upward (async)**: the iframe ↔ parent leg. A user-supplied
 *     `hostTransport` (typically composed with
 *     `wrapWindowPostMessage` for the direct variant or
 *     `wrapMessagePort` for the tunneled-MessagePort variant) moves
 *     normal `WireMessage`s back and forth. **The SAB never
 *     crosses this hop** — cross-origin SAB postMessage is rejected
 *     at the agent-cluster boundary.
 *
 * **Heartbeat threshold caveat.** A worker blocked in
 * `Atomics.wait` for a sync round-trip is silent on postMessage
 * for the duration of the call (`Atomics.notify` travels inside
 * the SAB, not via postMessage), so a too-low threshold will
 * declare a healthy-but-slow caller dead. `workerHeartbeatTimeoutMs`
 * MUST exceed the P99 of the slowest expected `rpc.wait` round
 * trip. Default 30000 ms matches the project's retention TTL
 * default; lower it only with measured headroom. The
 * `{__sync: 'client_dead'}` notification is processed by
 * `enableSyncServer`'s `handleClientDead`, which validates
 * the epoch, deduplicates, and invokes `onClientDead`.
 *
 * The worker still sees a fully synchronous `rpc.wait(...)`. The
 * parent sees only async RPC traffic. The broker absorbs the
 * impedance mismatch.
 *
 * **Wiring.** The broker is small: it pipes outbound traffic from
 * the wrapped host wrapper into `hostTransport.send`, and inbound
 * traffic from `hostTransport` into the wrapped host wrapper's
 * `send`. The wrapper itself handles `__sync` envelopes (handshake,
 * doorbell, pull), the chunk machine, the capture window — all the
 * heavy lifting is delegated.
 *
 * **Requirements.**
 *
 *   - The iframe must be `crossOriginIsolated` (COOP `same-origin`
 *     + COEP `require-corp`). Without isolation, `SharedArrayBuffer`
 *     is unusable; construction throws `SyncRPCIframeBridgeError`.
 *   - The worker must be same-origin to the iframe so the SAB
 *     transfer succeeds. Cross-origin worker construction would
 *     fail at SAB transfer with a `messageerror`; consumers see it
 *     surface as a handshake timeout on the worker side.
 *
 * **Inbound SAB content from the parent.** The broker does not
 * inspect inbound `hostTransport` payloads beyond piping them into
 * the wrapped host wrapper. The wrapper itself routes them; any
 * `SharedArrayBuffer` value the parent attempts to send across the
 * cross-origin boundary is rejected by the browser before it ever
 * reaches the broker (cross-origin SAB postMessage fires
 * `messageerror`). The broker requires no defensive logic here.
 *
 * @throws SyncRPCIframeBridgeError — `crossOriginIsolated !== true`
 *   in the broker's context.
 */
export function createIframeBrokerBridge(opts: {
  /** The extension worker the iframe spawned (same-origin). */
  worker: WorkerLike;
  /**
   * Async transport to the parent. Typically composed via
   * `wrapWindowPostMessage` (direct) or `wrapMessagePort`
   * (tunneled). The broker is agnostic to which shape the caller
   * picked.
   */
  hostTransport: RawTransport;
  /** Data SAB size in bytes; default 64 KiB. Min 4 KiB, max 256 KiB. */
  dataSabSize?: number;
  /** Heartbeat timeout for detecting blocked-worker death. */
  workerHeartbeatTimeoutMs?: number;
  /** Stable client identifier for this worker. Random if omitted. */
  clientId?: string;
}): IframeBrokerBridge {
  return _createIframeBrokerBridgeInternal(opts);
}

/**
 * Test-only escape hatch for `createIframeBrokerBridge` that accepts
 * a stubbed `crossOriginIsolated` value for unit tests without a
 * real COI runtime. Not part of the public API; imported directly
 * by tests and re-exported by `createIframeBrokerBridge` above.
 *
 * @internal
 */
export function _createIframeBrokerBridgeInternal(opts: {
  worker: WorkerLike;
  hostTransport: RawTransport;
  dataSabSize?: number;
  workerHeartbeatTimeoutMs?: number;
  clientId?: string;
  _crossOriginIsolated?: boolean;
}): IframeBrokerBridge {
  const {
    worker,
    hostTransport,
    dataSabSize,
    workerHeartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    clientId = crypto.randomUUID(),
    _crossOriginIsolated,
  } = opts;

  const coi =
    _crossOriginIsolated ??
    ((globalThis as unknown as {crossOriginIsolated?: boolean})
      .crossOriginIsolated ??
      false);
  if (coi !== true) {
    throw new SyncRPCIframeBridgeError(
      'createIframeBrokerBridge: this context is not crossOriginIsolated. ' +
        'Configure COOP `same-origin` + COEP `require-corp` on every ' +
        'document in the chain (parent page, iframe, worker source). ' +
        'See docs/sync-mode.md#iframe-bridge-errors for setup checklist.',
    );
  }

  let disposed = false;

  // ── Worker-side raw transport ─────────────────────────────────────────
  //
  // The broker's view of "the connection to the client". The host
  // wrapper wraps this to add sync semantics; inbound and outbound
  // traffic both flow through it.
  type WorkerListener = (
    data: unknown,
    ctx?: TransportContext,
  ) => void | Promise<void>;
  const workerListeners: WorkerListener[] = [];

  const workerInbound = (event: MessageEvent) => {
    if (disposed) return;
    armHeartbeat();
    for (const cb of workerListeners.slice()) cb(event.data);
  };
  worker.addEventListener('message', workerInbound);

  // Captured control SAB. The broker has direct access to it because
  // it allocated the lane (via enableSyncServer) inside its own agent
  // cluster. We intercept the hs-res as it flows from the wrapper to
  // the worker.
  let capturedControlSab: SharedArrayBuffer | null = null;
  let capturedEpoch = 0;

  const workerSideRaw: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      if (disposed) return;
      const transfer =
        (ctx as TransportContext | undefined)?.transfer ?? [];
      worker.postMessage(data, transfer);
    },
    onMessage(cb) {
      workerListeners.push(cb);
    },
  };

  // ── Host wrapper (sync server) ────────────────────────────────────────
  //
  // Wraps `workerSideRaw` so the worker side of the conversation
  // gets `enableSyncServer`'s full sync semantics — handshake, chunk
  // machine, capture window, doorbell + pull handling. The wrapper
  // is what the broker pipes traffic in and out of.
  const wrapper = enableSyncServer(workerSideRaw, {
    dataSabSize,
    clientId,
    onClientDead() {
      // Forward the death notification upstream to the parent.
      // This fires from enableSyncServer's CALLER_STATE poll
      // or its client_dead handler — the broker just relays.
      emitDeath();
    },
  });

  // ── Piping ────────────────────────────────────────────────────────────
  //
  // Outbound from worker → parent. The wrapper's `onMessage(cb)` is
  // the callback the host wrapper would normally hand to the RPC.
  // We register ours: any inbound message the wrapper has finished
  // unwrapping (synthesized sync-batch calls, pass-through async
  // frames) gets routed to the parent via `hostTransport`.
  wrapper.onMessage((data, ctx) => {
    if (disposed) return;
    hostTransport.send(data, ctx);
  });

  // Inbound from parent → worker. The parent sends a `WireMessage`
  // via `hostTransport`. We hand it to the wrapper's `send` so the
  // capture window (for in-flight sync batches) can intercept; non-
  // captured frames pass through the wrapper to `workerSideRaw.send`
  // → `worker.postMessage`.
  hostTransport.onMessage((data, ctx) => {
    if (disposed) return;
    wrapper.send(data, ctx);
  });

  // Intercept the wrapper's outbound traffic to the worker to capture
  // the hs-res (which carries the control SAB + epoch we need for
  // markCallerDead).
  const originalWorkerSend = workerSideRaw.send;
  workerSideRaw.send = (data, ctx) => {
    if (
      data &&
      typeof data === 'object' &&
      (data as {__sync?: string}).__sync === 'hs-res'
    ) {
      const d = data as {
        control?: SharedArrayBuffer;
        epoch?: number;
      };
      if (d.control instanceof SharedArrayBuffer) {
        capturedControlSab = d.control;
        capturedEpoch = typeof d.epoch === 'number' ? d.epoch : 0;
      }
    }
    originalWorkerSend.call(workerSideRaw, data, ctx);
  };

  // ── Heartbeat & death detection ──────────────────────────────────────
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let deadEmitted = false;

  function emitDeath(): void {
    if (disposed || deadEmitted) return;
    deadEmitted = true;
    if (capturedControlSab !== null) {
      markCallerDead({
        controlSab: capturedControlSab,
        hostTransport,
        epoch: capturedEpoch,
        clientId,
      });
    } else {
      // Pre-handshake death.
      hostTransport.send({
        __sync: 'client_dead',
        epoch: 0,
        clientId,
      });
    }
  }

  function armHeartbeat(): void {
    if (disposed || deadEmitted) return;
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      emitDeath();
    }, workerHeartbeatTimeoutMs);
  }

  // Worker error/messageerror detection.
  const onWorkerError = () => emitDeath();
  const onWorkerMessageError = () => emitDeath();
  worker.addEventListener('error', onWorkerError);
  worker.addEventListener('messageerror', onWorkerMessageError);

  // ── Inspection façade for `client` ───────────────────────────────────
  //
  // The `client` side of the bridge is the worker-postMessage
  // transport. We expose a thin façade that supports the
  // `RawTransport` shape for debug listeners. `server` is the
  // user-supplied `hostTransport` echoed back unchanged.
  const facadeCleanups: Array<() => void> = [];

  const clientFacade: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      if (disposed) return;
      const transfer =
        (ctx as TransportContext | undefined)?.transfer ?? [];
      worker.postMessage(data, transfer);
    },
    onMessage(cb) {
      if (disposed) return;
      const wrapped = (event: MessageEvent) => {
        if (disposed) return;
        cb(event.data);
      };
      worker.addEventListener('message', wrapped);
      facadeCleanups.push(() => worker.removeEventListener('message', wrapped));
    },
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.removeEventListener('message', workerInbound);
      worker.removeEventListener('error', onWorkerError);
      worker.removeEventListener('messageerror', onWorkerMessageError);
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      workerListeners.length = 0;
      for (const cleanup of facadeCleanups) cleanup();
      facadeCleanups.length = 0;
    },
    server: hostTransport,
    client: clientFacade,
  };
}

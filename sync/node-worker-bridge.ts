/**
 * Node `worker_threads` teardown detection helper.
 *
 * Wraps a Node `Worker` with death-detection wiring: listens for
 * `error` and `exit` events, plus an optional heartbeat, and sends
 * `{__sync: 'client_dead', epoch, clientId}` to the host transport
 * when any fires. The `enableSyncServer` wrapper processes the
 * notification and invokes the user's `onClientDead` callback.
 *
 * Exported only via the Node conditional entry (`sync/index.node.ts`).
 * The browser bundle never loads this file.
 *
 * Node has cleaner death detection than browsers: `exit` always fires
 * (even on `SIGKILL`), so heartbeat is a belt-and-suspenders measure
 * rather than a primary detection mechanism.
 *
 * **SAB marking.** The bridge does not directly mark `CALLER_STATE =
 * DEAD` in the SAB. In the iframe topologies (relay, broker), the
 * bridge intercepts the hs-res in transit to capture the SAB, but in
 * the Node case messages are often multiplexed through an envelope
 * wrapper (e.g., `{kind: 'mixed-signals', data}`) that makes
 * transparent interception fragile. Instead, the bridge sends the
 * `client_dead` notification to the `enableSyncServer` wrapper,
 * which handles SAB cleanup and invokes `onClientDead`. The server's
 * CALLER_STATE poll (`M003I005T`) covers the fast-abort path.
 */

import type {Worker} from 'node:worker_threads';
import type {RawTransport} from '../shared/protocol.ts';

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

export interface NodeWorkerBridge {
  /**
   * Tear down the bridge: stop event listeners, clear heartbeat
   * timer. Idempotent — calling more than once is a no-op.
   */
  dispose(): void;
}

/**
 * Create a teardown-detection bridge for a Node `worker_threads`
 * Worker.
 *
 * @param opts.worker - The Node Worker instance to monitor.
 * @param opts.hostTransport - Transport that `enableSyncServer`
 *   wraps. The bridge posts `client_dead` notifications here;
 *   the server's inbound handler processes them.
 * @param opts.clientId - Stable client identifier. Random if omitted.
 * @param opts.workerHeartbeatTimeoutMs - Heartbeat timeout. Default
 *   30000 ms. Set to 0 to disable heartbeat (rely on error/exit only).
 */
export function createNodeWorkerBridge(opts: {
  worker: Worker;
  hostTransport: RawTransport;
  clientId?: string;
  workerHeartbeatTimeoutMs?: number;
}): NodeWorkerBridge {
  const {
    worker,
    hostTransport,
    clientId = crypto.randomUUID(),
    workerHeartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  } = opts;

  let disposed = false;
  let deadEmitted = false;

  // Captured epoch from hs-res passing through the transport.
  // The bridge attempts to capture it from worker messages (which
  // may be wrapped) or falls back to epoch 0.
  let capturedEpoch = 0;

  function emitDeath(): void {
    if (disposed || deadEmitted) return;
    deadEmitted = true;
    try {
      hostTransport.send({
        __sync: 'client_dead',
        epoch: capturedEpoch,
        clientId,
      });
    } catch {
      // Transport may be disposed.
    }
  }

  // Heartbeat state.
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  function armHeartbeat(): void {
    if (disposed || deadEmitted || workerHeartbeatTimeoutMs <= 0) return;
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      emitDeath();
    }, workerHeartbeatTimeoutMs);
    (heartbeatTimer as unknown as {unref?: () => void}).unref?.();
  }

  // Monitor worker messages to arm heartbeat and attempt epoch capture.
  const onMessage = (data: unknown) => {
    if (disposed) return;
    armHeartbeat();
    // Try to capture epoch from hs-res (may be wrapped).
    tryCapture(data);
  };

  /** Recursively try to extract epoch from an hs-res message. */
  function tryCapture(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    if (d.__sync === 'hs-res' && typeof d.epoch === 'number') {
      capturedEpoch = d.epoch as number;
      return;
    }
    // Wrapped envelope (e.g., {kind: 'mixed-signals', data: ...}).
    if (d.data && typeof d.data === 'object') {
      tryCapture(d.data);
    }
  }

  const onError = () => emitDeath();
  const onExit = () => emitDeath();

  worker.on('message', onMessage);
  worker.on('error', onError);
  worker.on('exit', onExit);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  };
}

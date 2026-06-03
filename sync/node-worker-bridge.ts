/**
 * Node `worker_threads` teardown detection helper.
 *
 * Wraps a Node `Worker` with death-detection wiring: listens for
 * `error` and `exit` events, plus an optional heartbeat, and calls
 * `markCallerDead` when any fires. The helper does NOT spawn the
 * worker — the user creates and passes it in.
 *
 * Exported only via the Node conditional entry (`sync/index.node.ts`).
 * The browser bundle never loads this file.
 *
 * Node has cleaner death detection than browsers: `exit` always fires
 * (even on `SIGKILL`), so heartbeat is a belt-and-suspenders measure
 * rather than a primary detection mechanism.
 */

import type {Worker} from 'node:worker_threads';
import type {RawTransport} from '../shared/protocol.ts';
import {markCallerDead} from './lifecycle.ts';

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
 * Worker. Listens for `error`, `exit`, and heartbeat timeout, then
 * calls `markCallerDead` on the first detection signal.
 *
 * The bridge captures the control SAB and epoch from the `hs-res`
 * envelope as it passes through the host-facing transport. Before
 * the handshake completes, death notifications are sent with
 * `epoch: 0` (rejected by the host's epoch validation).
 *
 * @param opts.worker - The Node Worker instance to monitor.
 * @param opts.hostTransport - Transport facing the host (for
 *   `client_dead` notifications). This is the base transport BEFORE
 *   `enableSyncServer` wraps it — the bridge monitors worker events
 *   and posts notifications on this transport.
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

  // Captured from the hs-res envelope in transit.
  let capturedControlSab: SharedArrayBuffer | null = null;
  let capturedEpoch = 0;

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
      // Pre-handshake death: best-effort epoch-0 notification.
      try {
        hostTransport.send({
          __sync: 'client_dead',
          epoch: 0,
          clientId,
        });
      } catch {
        // Transport may be disposed.
      }
    }
  }

  // Heartbeat state. Armed on each worker message.
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  function armHeartbeat(): void {
    if (disposed || deadEmitted || workerHeartbeatTimeoutMs <= 0) return;
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      emitDeath();
    }, workerHeartbeatTimeoutMs);
    // Don't keep the Node event loop alive solely for the heartbeat.
    (heartbeatTimer as unknown as {unref?: () => void}).unref?.();
  }

  // Monitor worker messages to capture hs-res and arm heartbeat.
  const onMessage = (data: unknown) => {
    if (disposed) return;
    armHeartbeat();
    // Intercept hs-res to capture control SAB + epoch.
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
  };

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

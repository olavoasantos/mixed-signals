/**
 * Node `worker_threads` teardown detection helper.
 *
 * Wraps a Node `Worker` with death-detection wiring: listens for
 * `error` and `exit` events, plus an optional heartbeat, and calls
 * the `onDeath` callback when any fires. The consumer wires
 * `onDeath` to their cleanup logic (typically
 * `rpc.removeClient(clientId)`).
 *
 * Exported only via the Node conditional entry (`sync/index.node.ts`).
 * The browser bundle never loads this file.
 *
 * Node has cleaner death detection than browsers: `exit` always fires
 * (even on `SIGKILL`), so heartbeat is a belt-and-suspenders measure
 * rather than a primary detection mechanism.
 *
 * **Why `onDeath` instead of sending through a transport:** In the
 * iframe topologies (relay, broker), the bridge intercepts messages
 * in transit and can call `markCallerDead` to both store DEAD in
 * the SAB and send a `client_dead` notification. In the Node case
 * the bridge and `enableSyncServer` are co-located in the same
 * process, and the `RawTransport.send` direction is host→worker
 * (not into the server's inbound). The `onDeath` callback is the
 * direct, correct seam for co-located lifecycle owners.
 */

import type {Worker} from 'node:worker_threads';

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
 * @param opts.onDeath - Called once when the worker is detected as
 *   dead. Wire to cleanup logic (e.g., `rpc.removeClient(clientId)`).
 * @param opts.workerHeartbeatTimeoutMs - Heartbeat timeout. Default
 *   30000 ms. Set to 0 to disable heartbeat (rely on error/exit only).
 */
export function createNodeWorkerBridge(opts: {
  worker: Worker;
  onDeath: () => void;
  workerHeartbeatTimeoutMs?: number;
}): NodeWorkerBridge {
  const {
    worker,
    onDeath,
    workerHeartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  } = opts;

  let disposed = false;
  let deadEmitted = false;

  function emitDeath(): void {
    if (disposed || deadEmitted) return;
    deadEmitted = true;
    try {
      onDeath();
    } catch (err) {
      // Consumer callback threw — swallow. The lifecycle owner
      // has already decided death happened.
      // eslint-disable-next-line no-console
      console.warn('[mixed-signals/sync] createNodeWorkerBridge: onDeath callback threw', err);
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

  // Monitor worker messages to arm heartbeat.
  const onMessage = () => {
    if (disposed) return;
    armHeartbeat();
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

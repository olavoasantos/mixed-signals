/**
 * Browser entry: parent (host) side of the sync RPC harness.
 *
 * Generic infrastructure — no test-specific logic. Spawns a same-origin
 * Worker, builds a RawTransport over its postMessage channel, wraps with
 * `createSyncTransportHost`, registers with an `RPC` host.
 *
 * Exposes three globals for the Node-side harness to drive:
 *   - `rpc`        — the `RPC` host instance
 *   - `__root__`   — the stable root object (mutate in place via
 *                    `Object.assign` to publish methods; see
 *                    `SyncRpcWorkerClient.expose`)
 *   - `__worker__` — the spawned Worker, so `page.evaluate` can
 *                    `postMessage` directly to it for the eval bridge
 *
 * Sync RPC traffic and eval traffic share the same `Worker.postMessage`
 * channel, distinguished by message shape: eval messages carry a
 * `__type__` field; RPC / sync-control messages don't.
 */
import {RPC} from '../../../../server/rpc.ts';
import type {RawTransport} from '../../../../shared/protocol.ts';
import {createSyncTransportHost} from '../../../../sync/transport-host.ts';

const workerUrl = (globalThis as Record<string, unknown>).__WORKER_URL__ as string;
const worker = new Worker(workerUrl, {type: 'classic'});

const base: RawTransport = {
  mode: 'raw',
  send(data, ctx) {
    worker.postMessage(data, (ctx?.transfer as Transferable[]) ?? []);
  },
  onMessage(cb) {
    worker.addEventListener('message', (e) => {
      // Side-channel for evaluate — uses `__type__` field to avoid
      // conflicting with sync RPC traffic. Skip eval messages here.
      if (e.data && (e.data as {__type__?: unknown}).__type__) return;
      cb(e.data);
    });
  },
};

// Optional override: the test harness may set `__DATA_SAB_SIZE__` on
// `window` before this script runs to size the data SAB. Defaults to the
// library default (64 KiB) when unset.
const dataSabSize = (
  globalThis as unknown as {__DATA_SAB_SIZE__?: number}
).__DATA_SAB_SIZE__;
const syncHostTransport = createSyncTransportHost({
  base,
  dataSabSize,
});

// `mixed-signals`' `RPC.expose(root)` is idempotent on the `o0` handle,
// so we keep a stable root reference and mutate it via `Object.assign`.
// The hydrated `client.root` Proxy synthesizes method stubs by name, so
// methods added after the initial `@R` are callable transparently.
const rootObj: Record<string, unknown> = {};
const rpc = new RPC(rootObj);
rpc.addClient(syncHostTransport);

(globalThis as Record<string, unknown>).rpc = rpc;
(globalThis as Record<string, unknown>).__root__ = rootObj;
(globalThis as Record<string, unknown>).__worker__ = worker;

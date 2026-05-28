/**
 * Browser entry: iframe (broker) side of the cross-origin iframe-proxy
 * topology. The iframe is **same-origin to the worker** (it spawns the
 * worker), so SAB transfer between them works. The iframe is
 * **cross-origin to the parent** — that hop uses plain async postMessage
 * (no SABs), which has no agent-cluster restriction.
 *
 * The iframe is an **active broker**:
 *
 *   - Owns the control + data SABs.
 *   - On a worker doorbell, services the SAB envelope: reads the call
 *     batch, forwards each WireMessage to the parent via async
 *     postMessage, collects responses, writes the response envelope
 *     back to the SAB, `Atomics.notify`s the worker.
 *   - For async traffic (notifications, regular RPC calls), forwards
 *     verbatim between parent and worker.
 *
 * Implementation: reuses `createSyncTransportHost` from the sync
 * sub-bundle. That helper already owns the SAB state machine and the
 * sync request lifecycle; we just rewire its two endpoints:
 *
 *   - `wrapper.onMessage(cb)` \u2014 normally subscribed by a local RPC.
 *     Here we hook `cb` to "forward to parent". Each dispatched call
 *     during a sync batch goes out as an async postMessage to parent.
 *   - `wrapper.send(msg)` \u2014 normally called by a local RPC with
 *     responses. Here we call it with messages received from the parent.
 *     During a sync batch, `wrapper.send` captures matching results
 *     into the response buffer. Outside a sync batch, it forwards to
 *     the worker.
 */
import type {RawTransport} from '../../../../shared/protocol.ts';
import {createSyncTransportHost} from '../../../../sync/transport-host.ts';

const parentOrigin = (globalThis as Record<string, unknown>)
  .__PARENT_ORIGIN__ as string;
const workerUrl = (globalThis as Record<string, unknown>)
  .__WORKER_URL__ as string;
const dataSabSize = (
  globalThis as unknown as {__DATA_SAB_SIZE__?: number}
).__DATA_SAB_SIZE__;

const worker = new Worker(workerUrl, {type: 'classic'});
(globalThis as Record<string, unknown>).__worker__ = worker;

// Worker base transport: same-origin postMessage with SAB-friendly
// transfer semantics. The eval side-channel is filtered out so the
// SAB path only sees wire / sync-control messages.
const workerBase: RawTransport = {
  mode: 'raw',
  send(data, ctx) {
    worker.postMessage(data, (ctx?.transfer as Transferable[]) ?? []);
  },
  onMessage(cb) {
    worker.addEventListener('message', (e) => {
      if (e.data && (e.data as {__type__?: unknown}).__type__) return;
      cb(e.data);
    });
  },
};

// Reuse the existing sync host wrapper. It allocates SABs, runs the
// chunk-state machine, and dispatches sync requests via the `onMessage`
// callback that gets registered below.
const wrapper = createSyncTransportHost({base: workerBase, dataSabSize});

// (1) Worker-side dispatch \u2192 parent. The host calls this callback for
// every synthesized `call` WireMessage during a sync batch, AND for any
// async wire message a worker emits (e.g. via `client.call(...)`).
wrapper.onMessage((data, _ctx) => {
  window.parent.postMessage(data, parentOrigin);
});

// (2) Parent \u2192 wrapper.send. During a sync batch, the wrapper captures
// matching `result` / `error` messages. Outside, it passes through to
// `workerBase.send` (the worker).
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (event.origin !== parentOrigin) return;
  // Eval bridge messages are handled by the separate listeners below.
  if (event.data && (event.data as {__type__?: unknown}).__type__) return;
  wrapper.send(event.data);
});

// Eval side-channel: forward `__type__` messages transparently between
// parent and worker. The wrapper above ignores them.
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (event.origin !== parentOrigin) return;
  if (!event.data || !(event.data as {__type__?: unknown}).__type__) return;
  worker.postMessage(event.data);
});
worker.addEventListener('message', (e) => {
  if (!e.data || !(e.data as {__type__?: unknown}).__type__) return;
  window.parent.postMessage(e.data, parentOrigin);
});

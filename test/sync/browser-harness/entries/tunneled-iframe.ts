/**
 * Browser entry: iframe (broker) side of the **tunneled-MessagePort**
 * cross-origin iframe-broker topology.
 *
 * Same broker mechanics as `proxy-iframe.ts` — owns the SAB, runs
 * the sync state machine via `createSyncTransportHost`, dispatches
 * worker requests as async wire messages — but the upward transport
 * to the parent is a **MessagePort that arrived via the worker**, not
 * `window.parent.postMessage`.
 *
 * Setup sequence:
 *
 *   parent (cross-origin) — creates `MessageChannel`. Sends `port2`
 *                            to the iframe via
 *                            `iframe.contentWindow.postMessage(
 *                              {__type__: 'tunnel-init'},
 *                              iframeOrigin,
 *                              [port2]
 *                            )`.
 *
 *   iframe (this entry) — receives the message, forwards the port to
 *                          the worker for the trust hop.
 *
 *   worker — receives the port, immediately re-transfers it back via
 *             `self.postMessage({__type__: 'tunneled-port'}, [port])`.
 *
 *   iframe — receives the port BACK from the worker, wires it as the
 *             broker's upstream transport. The port handle has
 *             traveled through the worker, inheriting the worker's
 *             trust chain.
 *
 * Messages on the tunneled port:
 *   - inbound (parent → iframe): WireMessages to feed into wrapper.send
 *   - outbound (iframe → parent): WireMessages emitted by wrapper.onMessage
 *
 * The eval side-channel stays on `window.postMessage` because it's
 * test-infrastructure, not part of the RPC transport contract.
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
// transfer semantics. Filters out side-channel messages so the SAB
// path only sees wire / sync-control frames.
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

// Reuse the existing sync host wrapper. Same SAB state machine as
// `proxy-iframe.ts`; only the upstream transport differs.
const wrapper = createSyncTransportHost({base: workerBase, dataSabSize});

// The tunneled port arrives asynchronously (parent → iframe → worker
// → iframe). Until it lands, buffer any outbound messages from the
// wrapper so the broker can keep running.
let hostPort: MessagePort | null = null;
const outboundBuffer: unknown[] = [];

wrapper.onMessage((data, _ctx) => {
  if (hostPort) {
    hostPort.postMessage(data);
  } else {
    outboundBuffer.push(data);
  }
});

// Step 1: receive the bare port from the parent via window.postMessage.
// Forward it to the worker for the trust-establishing re-transfer.
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (event.origin !== parentOrigin) return;
  const d = event.data as {__type__?: string} | undefined;
  if (d?.__type__ !== 'tunnel-init') return;
  const port = event.ports[0];
  if (!port) return;
  worker.postMessage({__type__: 'tunnel-init'}, [port]);
});

// Step 2: receive the port BACK from the worker. Wire it to the broker.
worker.addEventListener('message', (e) => {
  const d = e.data as {__type__?: string} | undefined;
  if (d?.__type__ !== 'tunneled-port') return;
  const port = e.ports[0];
  if (!port) return;
  if (hostPort) return; // already wired (shouldn't happen but guard)
  hostPort = port;

  // Parent → wrapper.send. Skip eval side-channel messages.
  port.addEventListener('message', (msg) => {
    if (msg.data && (msg.data as {__type__?: unknown}).__type__) return;
    wrapper.send(msg.data);
  });
  port.start();

  // Drain anything buffered before the port arrived.
  while (outboundBuffer.length > 0) {
    port.postMessage(outboundBuffer.shift());
  }
});

// Eval side-channel: forward `__type__` messages transparently between
// parent (via window.postMessage) and worker. Note: NOT routed through
// the tunneled port — those messages are RPC-only.
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (event.origin !== parentOrigin) return;
  const d = event.data as {__type__?: unknown} | undefined;
  if (!d || !d.__type__) return;
  // Don't forward our own tunnel-init to the worker via postMessage;
  // the dedicated handler above does that with a port transfer.
  if (d.__type__ === 'tunnel-init') return;
  worker.postMessage(event.data);
});
worker.addEventListener('message', (e) => {
  const d = e.data as {__type__?: unknown} | undefined;
  if (!d || !d.__type__) return;
  // Don't forward our own tunneled-port to parent.
  if (d.__type__ === 'tunneled-port') return;
  window.parent.postMessage(e.data, parentOrigin);
});

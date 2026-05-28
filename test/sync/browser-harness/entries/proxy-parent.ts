/**
 * Browser entry: parent (host) side of the cross-origin iframe-broker
 * topology. The parent lives at one origin (e.g. `https://shop.test`);
 * the iframe lives at a different origin (e.g. `https://ext.test`) and
 * spawns the worker.
 *
 * The parent talks to the iframe via **plain async postMessage** — no
 * SABs cross this boundary. The iframe (broker) holds the SABs and
 * services the worker's sync requests by translating them into async
 * postMessage calls to the parent. The parent sees only async traffic.
 *
 * Globals for the Node-side harness:
 *   - `rpc`            — the `RPC` host instance
 *   - `__root__`       — stable root (mutate via `Object.assign`)
 *   - `__iframe__`     — iframe element (for the eval bridge)
 *   - `__iframeOrigin__` — iframe's origin (for the eval bridge)
 */
import {RPC} from '../../../../server/rpc.ts';
import type {RawTransport} from '../../../../shared/protocol.ts';

const iframeOrigin = (globalThis as Record<string, unknown>)
  .__IFRAME_ORIGIN__ as string;

const iframe = document.createElement('iframe');
iframe.src = `${iframeOrigin}/`;
// `allow="cross-origin-isolated"` so the iframe can be COI in its own
// agent cluster (needed for the iframe ↔ worker SAB transfer).
iframe.setAttribute('allow', 'cross-origin-isolated');
document.body.appendChild(iframe);

// Plain async postMessage transport from parent to the iframe broker.
// No SABs flow on this path — only WireMessages.
const base: RawTransport = {
  mode: 'raw',
  send(data, _ctx) {
    iframe.contentWindow?.postMessage(data, iframeOrigin);
  },
  onMessage(cb) {
    window.addEventListener('message', (event) => {
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== iframeOrigin) return;
      // Skip eval side-channel messages (carry `__type__`).
      if (event.data && (event.data as {__type__?: unknown}).__type__) return;
      cb(event.data);
    });
  },
};

const rootObj: Record<string, unknown> = {};
const rpc = new RPC(rootObj);

// Defer `addClient` until the iframe finishes loading its bundle.
// `addClient` fires the `@R` notification synchronously; before iframe
// load, `iframe.contentWindow` is the about:blank window.
iframe.addEventListener('load', () => {
  rpc.addClient(base);
});

(globalThis as Record<string, unknown>).rpc = rpc;
(globalThis as Record<string, unknown>).__root__ = rootObj;
(globalThis as Record<string, unknown>).__iframe__ = iframe;
(globalThis as Record<string, unknown>).__iframeOrigin__ = iframeOrigin;

/**
 * Browser entry: parent (host) side of the iframe sync RPC topology.
 *
 * Creates an iframe (same-origin, at a different path), builds a
 * RawTransport over `iframe.contentWindow.postMessage`, wraps with
 * `createSyncTransportHost`, registers with an `RPC` host. The iframe
 * spawns the worker; sync RPC traffic flows parent ↔ iframe ↔ worker.
 *
 * Globals set on the parent page for the Node-side harness to drive:
 *   - `rpc`            — the `RPC` host instance
 *   - `__root__`       — stable root object (mutate via `Object.assign`)
 *   - `__iframe__`     — the iframe element (so `page.evaluate` can
 *                        post directly for the test-eval bridge)
 *   - `__iframeUrl__`  — the iframe URL (used by `workerEvaluate`)
 */
import {RPC} from '../../../../server/rpc.ts';
import type {RawTransport} from '../../../../shared/protocol.ts';
import {createSyncTransportHost} from '../../../../sync/transport-host.ts';

const iframeUrl = (globalThis as Record<string, unknown>).__IFRAME_URL__ as string;
const pageOrigin = (globalThis as Record<string, unknown>).__ORIGIN__ as string;

const iframe = document.createElement('iframe');
iframe.src = iframeUrl;
// `allow="cross-origin-isolated"` is required to grant COI to a
// cross-origin iframe. We use a same-origin iframe here (because COI
// implies origin-keyed agent clusters, which forbid cross-origin SAB
// transfer) so this attribute is informational — but keeping it
// documents the requirement for any future cross-origin variant.
iframe.setAttribute('allow', 'cross-origin-isolated');
document.body.appendChild(iframe);

const base: RawTransport = {
  mode: 'raw',
  send(data, _ctx) {
    // Always re-access contentWindow: it's the iframe's CURRENT window
    // (the initial about:blank window may have been replaced after
    // navigation). Capturing it once at setup time risks posting to a
    // stale Window that no longer exists.
    iframe.contentWindow?.postMessage(data, pageOrigin);
  },
  onMessage(cb) {
    window.addEventListener('message', (event) => {
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== pageOrigin) return;
      // Skip eval side-channel messages.
      if (event.data && (event.data as {__type__?: unknown}).__type__) return;
      cb(event.data);
    });
  },
};

const dataSabSize = (
  globalThis as unknown as {__DATA_SAB_SIZE__?: number}
).__DATA_SAB_SIZE__;
const syncHostTransport = createSyncTransportHost({base, dataSabSize});

const rootObj: Record<string, unknown> = {};
const rpc = new RPC(rootObj);

// Defer `addClient` until the iframe has finished loading its bundle.
// `addClient` synchronously fires the `@R` notification; before iframe
// load, `iframe.contentWindow` is the initial about:blank Window, so
// the post would land somewhere harmless (lost on navigation).
iframe.addEventListener('load', () => {
  rpc.addClient(syncHostTransport);
});

(globalThis as Record<string, unknown>).rpc = rpc;
(globalThis as Record<string, unknown>).__root__ = rootObj;
(globalThis as Record<string, unknown>).__iframe__ = iframe;
(globalThis as Record<string, unknown>).__iframeUrl__ = iframeUrl;

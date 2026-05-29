/**
 * Browser entry: parent (host) side of the **tunneled-MessagePort**
 * cross-origin iframe-broker topology.
 *
 * Differences from `proxy-parent.ts`:
 *   - Creates a `MessageChannel`. Keeps `port1` for itself; transfers
 *     `port2` to the iframe at handshake (§6.5 of the design doc).
 *   - Builds the RPC's RawTransport on top of `port1.postMessage` /
 *     `port1.addEventListener('message')`, NOT
 *     `iframe.contentWindow.postMessage` / `window.addEventListener`.
 *   - The eval side-channel (test infrastructure) still flows over
 *     `window.postMessage` to keep concerns separated.
 *
 * The parent never has to verify origins on inbound RPC messages —
 * possession of `port1` IS the channel identity. This integrates
 * cleanly with existing MessagePort-based async transport shapes (the
 * common pattern for cross-origin sandbox frameworks).
 */
import {RPC} from '../../../../server/rpc.ts';
import type {RawTransport} from '../../../../shared/protocol.ts';

const iframeOrigin = (globalThis as Record<string, unknown>)
  .__IFRAME_ORIGIN__ as string;

const iframe = document.createElement('iframe');
iframe.src = `${iframeOrigin}/`;
iframe.setAttribute('allow', 'cross-origin-isolated');
document.body.appendChild(iframe);

// Create the sync MessageChannel up front. port1 stays here, port2
// will tunnel through the worker to the iframe broker.
const channel = new MessageChannel();
const hostPort = channel.port1;
const brokerPort = channel.port2;

// RPC RawTransport built on the host-side port. Skips eval side-channel
// messages (carry `__type__`) so the RPC layer only sees wire frames.
const base: RawTransport = {
  mode: 'raw',
  send(data, _ctx) {
    hostPort.postMessage(data);
  },
  onMessage(cb) {
    hostPort.addEventListener('message', (event) => {
      const d = event.data as {__type__?: unknown} | undefined;
      if (d && d.__type__) return;
      cb(event.data);
    });
    hostPort.start();
  },
};

const rootObj: Record<string, unknown> = {};
const rpc = new RPC(rootObj);

iframe.addEventListener('load', () => {
  // Send the broker port to the iframe at handshake. The iframe will
  // re-transfer it via the worker (trust hop), then wire it as its
  // upstream transport.
  iframe.contentWindow!.postMessage(
    {__type__: 'tunnel-init'},
    iframeOrigin,
    [brokerPort],
  );
  // Adding the client triggers the sync handshake (`hs-req` flows via
  // `base.send` → hostPort.postMessage). MessagePort queues until the
  // iframe wires its end up, so the message survives in-flight.
  rpc.addClient(base);
});

(globalThis as Record<string, unknown>).rpc = rpc;
(globalThis as Record<string, unknown>).__root__ = rootObj;
(globalThis as Record<string, unknown>).__iframe__ = iframe;
(globalThis as Record<string, unknown>).__iframeOrigin__ = iframeOrigin;

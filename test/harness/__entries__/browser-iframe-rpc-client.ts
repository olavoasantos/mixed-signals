/**
 * Built-in browser iframe entry that auto-creates an RPCClient.
 *
 * The RPCClient is wired to __port and exposed as globalThis.client.
 */
import {RPCClient} from '../../../client/index.ts';

const port = (globalThis as any).__port;
if (!port) throw new Error('No __port found');

const client = new RPCClient({
  send(data: string) {
    port.postMessage(data);
  },
  onMessage(cb) {
    port.addEventListener('message', (ev: MessageEvent) => {
      cb({toString: () => String(ev.data)});
    });
    port.start();
  },
  ready: Promise.resolve(),
});

(globalThis as any).client = client;

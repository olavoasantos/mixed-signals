/**
 * Built-in browser worker entry that auto-creates an RPCClient.
 *
 * The RPCClient is wired to self (postMessage/addEventListener) and
 * exposed as globalThis.client. The eval side-channel shares the
 * same self channel, discriminated by __type__.
 */
import {RPCClient} from '../../../client/index.ts';

const client = new RPCClient({
  send(data: string) {
    self.postMessage(data);
  },
  onMessage(cb) {
    self.addEventListener('message', (ev: MessageEvent) => {
      // Ignore eval side-channel messages
      if (ev.data?.__type__ === 'eval') return;
      cb({toString: () => String(ev.data)});
    });
  },
  ready: Promise.resolve(),
});

(globalThis as any).client = client;

// Eval side-channel
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.__type__ !== 'eval') return;
  const {code, args, __id__} = data;
  try {
    const fn = new Function('args', `return (${code})(...args)`);
    const result = fn(args || []);
    if (result && typeof result === 'object' && typeof result.then === 'function') {
      result.then(
        (r: unknown) => self.postMessage({__type__: 'evalResult', __id__, result: r}),
        (e: Error) => self.postMessage({__type__: 'evalResult', __id__, error: e.message}),
      );
    } else {
      self.postMessage({__type__: 'evalResult', __id__, result});
    }
  } catch (e: any) {
    self.postMessage({__type__: 'evalResult', __id__, error: e.message});
  }
});

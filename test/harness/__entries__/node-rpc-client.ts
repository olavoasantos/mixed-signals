/**
 * Built-in Node worker entry that auto-creates an RPCClient.
 *
 * The RPCClient is wired to workerData.port and exposed as
 * globalThis.client. The eval side-channel runs on parentPort.
 */
import {parentPort, workerData} from 'node:worker_threads';
import {RPCClient} from '../../../client/index.ts';

if (!parentPort) throw new Error('No parentPort');
const dataPort = workerData?.port as import('node:worker_threads').MessagePort;
if (!dataPort) throw new Error('No data port in workerData');

const client = new RPCClient({
  send(data: string) {
    dataPort.postMessage(data);
  },
  onMessage(cb) {
    dataPort.on('message', (d) => cb({toString: () => String(d)}));
  },
  ready: Promise.resolve(),
});

(globalThis as any).client = client;

// Eval side-channel
parentPort.on('message', (data: unknown) => {
  if (!data || typeof data !== 'object' || (data as any).__type__ !== 'eval') return;
  const {code, args, __id__} = data as any;
  try {
    const fn = new Function('args', `return (${code})(...args)`);
    const result = fn(args || []);
    if (result && typeof result === 'object' && typeof result.then === 'function') {
      result.then(
        (r: unknown) => parentPort!.postMessage({__type__: 'evalResult', __id__, result: r}),
        (e: Error) => parentPort!.postMessage({__type__: 'evalResult', __id__, error: e.message}),
      );
    } else {
      parentPort.postMessage({__type__: 'evalResult', __id__, result});
    }
  } catch (e: any) {
    parentPort.postMessage({__type__: 'evalResult', __id__, error: e.message});
  }
});

parentPort.postMessage({__type__: 'ready'});

/**
 * Built-in Node worker entry that auto-creates a sync-capable RPCClient.
 *
 * Identical to `node-rpc-client.ts` except the transport is wrapped
 * with `enableSyncClient` before being passed to `RPCClient`. This
 * gives the client a `wait()` method backed by SAB + Atomics.
 *
 * The RPCClient is wired to workerData.port and exposed as
 * globalThis.client. The eval side-channel runs on parentPort.
 */
import {parentPort, workerData} from 'node:worker_threads';
import {RPCClient} from '../../../client/index.ts';
import {typeOfRemote} from '../../../shared/brand.ts';
import {enableSyncClient} from '../../../sync/client.ts';
import type {RawTransport} from '../../../shared/protocol.ts';

if (!parentPort) throw new Error('No parentPort');
const dataPort = workerData?.port as import('node:worker_threads').MessagePort;
if (!dataPort) throw new Error('No data port in workerData');

// Expose utilities on globalThis so evaluate() calls can use them.
(globalThis as any).typeOfRemote = typeOfRemote;

const base: RawTransport = {
  mode: 'raw',
  send(data: unknown) {
    dataPort.postMessage(data);
  },
  onMessage(cb) {
    dataPort.on('message', (d) => cb(d));
  },
};

// Eval side-channel — runs on parentPort, independent of data channel.
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
      parentPort!.postMessage({__type__: 'evalResult', __id__, result});
    }
  } catch (e: any) {
    parentPort!.postMessage({__type__: 'evalResult', __id__, error: e.message});
  }
});

(async () => {
  try {
    const transport = await enableSyncClient(base, {timeoutMs: 5000});
    const client = new RPCClient(transport);
    await client.ready;

    (globalThis as any).client = client;

    parentPort!.postMessage({__type__: 'ready'});
  } catch (err: any) {
    // Signal fatal error so the harness doesn't hang waiting for ready.
    parentPort!.postMessage({__type__: 'ready'});
    throw err;
  }
})();

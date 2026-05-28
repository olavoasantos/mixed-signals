/**
 * Worker-side entry for the sync RPC integration test.
 *
 * Runs in a `node:worker_threads` Worker. Builds a RawTransport over
 * `parentPort`, accepts a sync transport via SAB handshake, builds an
 * `RPCClient`, and exposes a tiny command protocol over `parentPort` so
 * the main-thread test can drive it.
 */
import {parentPort} from 'node:worker_threads';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {RPCClient} from '../../client/rpc.ts';
import {acceptSyncTransport} from '../../sync/transport-caller.ts';

if (!parentPort) {
  throw new Error('worker-entry must run inside a Node Worker');
}

process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[worker uncaught]', err);
  parentPort!.postMessage({
    kind: 'test',
    data: {type: 'fatal', error: (err as Error).stack ?? (err as Error).message},
  });
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[worker unhandled rejection]', reason);
  parentPort!.postMessage({
    kind: 'test',
    data: {
      type: 'fatal',
      error: (reason as Error)?.stack ?? String(reason),
    },
  });
});

// Adapter: wrap parentPort as a mixed-signals RawTransport.
//
// We need to multiplex two channels on the same MessagePort:
//   1. The sync transport's handshake + doorbell + RPC base traffic.
//   2. Test-driver commands (run a method, return its result back).
//
// Multiplex with a tagged envelope. `{kind: 'mixed-signals', data: ...}`
// goes to the RawTransport; `{kind: 'test', ...}` goes to the test driver.
const rpcListeners: Array<
  (data: unknown, ctx?: TransportContext) => void | Promise<void>
> = [];
const testListeners: Array<(data: unknown) => void> = [];

parentPort.on('message', (envelope: {kind: string; data: unknown}) => {
  if (envelope?.kind === 'mixed-signals') {
    for (const listener of rpcListeners) listener(envelope.data);
  } else if (envelope?.kind === 'test') {
    for (const listener of testListeners) listener(envelope.data);
  }
});

const base: RawTransport = {
  mode: 'raw',
  send(data, _ctx) {
    parentPort!.postMessage({kind: 'mixed-signals', data});
  },
  onMessage(cb) {
    rpcListeners.push(cb);
  },
};

function sendTest(data: unknown) {
  parentPort!.postMessage({kind: 'test', data});
}

(async () => {
  try {
    const syncTransport = await acceptSyncTransport({base, timeoutMs: 5000});
    const client = new RPCClient(syncTransport);
    await client.ready;

    sendTest({type: 'ready'});

    testListeners.push((cmd: unknown) => {
      const c = cmd as {type: string; id?: number};
      if (c.type === 'sync-call-now') {
        try {
          // Use rpc.wait to call rpc.root.now() synchronously via SAB.
          const [value] = client.wait([client.root.now()]);
          sendTest({type: 'sync-call-now-result', id: c.id, ok: true, value});
        } catch (err) {
          sendTest({
            type: 'sync-call-now-result',
            id: c.id,
            ok: false,
            error: (err as Error).message,
          });
        }
      } else if (c.type === 'sync-call-add') {
        try {
          const args = (cmd as {args: [number, number]}).args;
          const [sum] = client.wait([client.root.add(args[0], args[1])]);
          sendTest({type: 'sync-call-add-result', id: c.id, ok: true, sum});
        } catch (err) {
          sendTest({
            type: 'sync-call-add-result',
            id: c.id,
            ok: false,
            error: (err as Error).message,
          });
        }
      } else if (c.type === 'can-wait') {
        sendTest({type: 'can-wait-result', id: c.id, value: client.canWait()});
      } else if (c.type === 'sync-call-echolen') {
        try {
          const arg = (cmd as {arg: string}).arg;
          const [value] = client.wait([client.root.echoLen(arg)]);
          sendTest({
            type: 'sync-call-echolen-result',
            id: c.id,
            ok: true,
            value,
          });
        } catch (err) {
          sendTest({
            type: 'sync-call-echolen-result',
            id: c.id,
            ok: false,
            error: (err as Error).message,
          });
        }
      } else if (c.type === 'sync-call-bigstring') {
        try {
          const n = (cmd as {n: number}).n;
          const [value] = client.wait([client.root.bigString(n)]);
          sendTest({
            type: 'sync-call-bigstring-result',
            id: c.id,
            ok: true,
            value,
          });
        } catch (err) {
          sendTest({
            type: 'sync-call-bigstring-result',
            id: c.id,
            ok: false,
            error: (err as Error).message,
          });
        }
      } else if (c.type === 'sync-call-echo') {
        try {
          const arg = (cmd as {arg: string}).arg;
          const [value] = client.wait([client.root.echo(arg)]);
          sendTest({
            type: 'sync-call-echo-result',
            id: c.id,
            ok: true,
            value,
          });
        } catch (err) {
          sendTest({
            type: 'sync-call-echo-result',
            id: c.id,
            ok: false,
            error: (err as Error).message,
          });
        }
      }
    });
  } catch (err) {
    sendTest({type: 'fatal', error: (err as Error).message});
  }
})();

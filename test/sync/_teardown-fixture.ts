/**
 * Worker-side fixture for teardown integration tests.
 *
 * Runs a real RPCClient over an enableSyncClient-wrapped transport.
 * Responds to test-driver commands and can be terminated mid-wait
 * to exercise the death-detection chain.
 */
import {parentPort} from 'node:worker_threads';
import {RPCClient} from '../../client/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncClient} from '../../sync/client.ts';

if (!parentPort) {
  throw new Error('_teardown-fixture must run inside a Node Worker');
}

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

function sendTest(data: unknown): void {
  parentPort!.postMessage({kind: 'test', data});
}

(async () => {
  try {
    const transport = await enableSyncClient(base, {timeoutMs: 5000});
    const client = new RPCClient(transport);
    await client.ready;

    sendTest({type: 'ready'});

    testListeners.push((cmd: unknown) => {
      const c = cmd as {
        type: string;
        id: number;
        method?: string;
        args?: unknown[];
        timeoutMs?: number;
      };

      try {
        switch (c.type) {
          case 'sync-call': {
            const [value] = client.wait(
              [client.root[c.method!](...(c.args ?? []))],
              c.timeoutMs ? {timeoutMs: c.timeoutMs} : undefined,
            );
            sendTest({type: 'sync-call-result', id: c.id, ok: true, value});
            return;
          }
          case 'sync-call-expect-throw': {
            try {
              client.wait(
                [client.root[c.method!](...(c.args ?? []))],
                c.timeoutMs ? {timeoutMs: c.timeoutMs} : undefined,
              );
              sendTest({
                type: 'sync-call-expect-throw-result',
                id: c.id,
                ok: false,
                error: 'expected wait to throw',
              });
            } catch (err) {
              sendTest({
                type: 'sync-call-expect-throw-result',
                id: c.id,
                ok: true,
                errorName: (err as Error).name,
                errorMessage: (err as Error).message,
              });
            }
            return;
          }
          case 'acquire-handles': {
            // Acquire N object handles and report back.
            const count = (c.args?.[0] as number) ?? 1;
            const promises = [];
            for (let i = 0; i < count; i++) {
              promises.push(client.root.createHandle(i));
            }
            const values = client.wait(promises);
            sendTest({
              type: 'acquire-handles-result',
              id: c.id,
              ok: true,
              count: values.length,
            });
            return;
          }
          case 'infinite-loop': {
            // Enter an infinite sync loop — no death events will fire.
            // Only timeoutMs can rescue the worker.
            try {
              client.wait(
                [client.root.hang()],
                c.timeoutMs ? {timeoutMs: c.timeoutMs} : undefined,
              );
              sendTest({
                type: 'infinite-loop-result',
                id: c.id,
                ok: false,
                error: 'hang did not throw',
              });
            } catch (err) {
              sendTest({
                type: 'infinite-loop-result',
                id: c.id,
                ok: true,
                errorName: (err as Error).name,
                errorMessage: (err as Error).message,
              });
            }
            return;
          }
        }
      } catch (err) {
        sendTest({
          type: 'command-error',
          id: c.id,
          ok: false,
          error: (err as Error).message,
        });
      }
    });
  } catch (err) {
    sendTest({type: 'fatal', error: (err as Error).message});
  }
})();

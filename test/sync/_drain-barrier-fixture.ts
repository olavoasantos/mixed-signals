/**
 * Worker-side fixture for drain-barrier end-to-end tests. Runs a
 * real `RPCClient` over `enableSyncClient` and exercises signal
 * watching + sync calls to validate the drain-barrier contract.
 *
 * Multiplexes two channels over `parentPort`:
 *   `{kind: 'mixed-signals', data}` — sync-RPC base transport.
 *   `{kind: 'test', data}` — test-driver commands.
 */
import {parentPort} from 'node:worker_threads';
import {effect} from '@preact/signals-core';
import {RPCClient} from '../../client/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncClient} from '../../sync/client.ts';

if (!parentPort) {
  throw new Error('_drain-barrier-fixture must run inside a Node Worker');
}

const rpcListeners: Array<
  (data: unknown, ctx?: TransportContext) => void | Promise<void>
> = [];
const testListeners: Array<(data: unknown) => void> = [];

parentPort.on('message', (envelope: {kind: string; data: unknown}) => {
  if (envelope?.kind === 'mixed-signals') {
    for (const listener of rpcListeners) listener(envelope.data);
  } else if (envelope?.kind === 'test') {
    for (const listener of [...testListeners]) listener(envelope.data);
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

/** Flush pending @W/@U/@D batches so watches register before sync. */
function flushWatchBatches(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** Resolve a dotted path on a proxy to reach a signal. */
function resolveSignal(root: any, path: string): {value: unknown} {
  const parts = path.split('.');
  let current = root;
  for (const part of parts) {
    current = current[part];
  }
  return current;
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
        signalPath?: string;
      };

      // Wrap in async IIFE so we can await watch-batch flushes
      // before blocking with Atomics.wait.
      void (async () => {
        try {
          switch (c.type) {
            // ── Signal mutation from sync call ──────────────────────
            case 'watch-and-sync-mutate': {
              const sig = resolveSignal(client.root, c.signalPath!);
              const observed: unknown[] = [];
              const dispose = effect(() => {
                observed.push(sig.value);
              });
              // Wait for @W to flush to the server.
              await flushWatchBatches();
              const [result] = client.wait([
                client.root[c.method!](...(c.args ?? [])),
              ]);
              const signalValue = sig.value;
              dispose();
              sendTest({
                type: 'watch-and-sync-mutate-result',
                id: c.id,
                ok: true,
                result,
                signalValue,
                observedCount: observed.length,
                observed,
              });
              return;
            }

            // ── Microtask exhaustion replay ───────────────────────
            case 'microtask-flood-then-sync': {
              const sig = resolveSignal(client.root, c.signalPath!);
              let updateCount = 0;
              const dispose = effect(() => {
                sig.value;
                updateCount++;
              });
              updateCount = 0;
              // Wait for @W to flush to the server.
              await flushWatchBatches();

              // Flood microtasks to keep the worker busy so async @S
              // frames pile up in the postMessage queue.
              const floodCount = (c.args?.[0] as number) ?? 100;
              for (let i = 0; i < floodCount; i++) {
                queueMicrotask(() => {
                  let x = 0;
                  for (let j = 0; j < 100; j++) x += Math.sqrt(j);
                  void x;
                });
              }

              const [result] = client.wait([
                client.root[c.method!](),
              ]);
              const signalValue = sig.value;
              dispose();
              sendTest({
                type: 'microtask-flood-then-sync-result',
                id: c.id,
                ok: true,
                result,
                signalValue,
                updateCount,
              });
              return;
            }

            // ── Between-call frame application ──────────────────────
            case 'between-call-sync': {
              const sig = resolveSignal(client.root, c.signalPath!);
              const dispose = effect(() => {
                sig.value;
              });
              // Wait for @W to flush to the server.
              await flushWatchBatches();

              // First sync call (call A).
              client.wait([client.root.nop()]);

              // Signal the test driver that call A is done.
              sendTest({
                type: 'between-call-a-done',
                id: c.id,
              });
              dispose();
              return;
            }

            case 'between-call-b': {
              const sig = resolveSignal(client.root, c.signalPath!);
              let updateCount = 0;
              const dispose = effect(() => {
                sig.value;
                updateCount++;
              });
              updateCount = 0;

              // Second sync call (call B). The drain barrier should
              // replay any idle-path frames emitted since call A.
              const [resultB] = client.wait([
                client.root.nop(),
              ]);
              const signalValue = sig.value;
              dispose();
              sendTest({
                type: 'between-call-b-result',
                id: c.id,
                ok: true,
                resultB,
                signalValue,
                updateCount,
              });
              return;
            }

            // ── Generic sync call ────────────────────────────────────
            case 'sync-call': {
              const [value] = client.wait([
                client.root[c.method!](...(c.args ?? [])),
              ]);
              sendTest({
                type: 'sync-call-result',
                id: c.id,
                ok: true,
                value,
              });
              return;
            }
          }
        } catch (err) {
          sendTest({
            type: 'command-result',
            id: c.id,
            ok: false,
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
        }
      })();
    });
  } catch (err) {
    sendTest({type: 'fatal', error: (err as Error).message});
  }
})();

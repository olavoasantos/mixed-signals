/**
 * Shared harness for drain-barrier E2E tests. Spins up a real RPC
 * server + enableSyncServer wrapper + Node worker running the
 * drain-barrier fixture.
 */
import {Worker} from 'node:worker_threads';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL(
  './_drain-barrier-fixture.ts',
  import.meta.url,
);

export interface Harness {
  worker: Worker;
  rpc: RPC;
  root: any;
  cmd: <T = unknown>(command: {
    type: string;
    [k: string]: unknown;
  }) => Promise<T>;
  waitForMsg: <T = unknown>(type: string) => Promise<T>;
  dispose: () => Promise<void>;
}

export function setupHarness(root: object): Harness {
  const worker = new Worker(WORKER_URL);
  worker.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error('[worker error]', err);
  });

  const rpcListeners: Array<
    (data: unknown, ctx?: TransportContext) => void | Promise<void>
  > = [];
  const testListeners: Array<(data: unknown) => void> = [];

  worker.on('message', (envelope: {kind: string; data: unknown}) => {
    if (envelope?.kind === 'mixed-signals') {
      for (const listener of rpcListeners) listener(envelope.data);
    } else if (envelope?.kind === 'test') {
      for (const listener of [...testListeners]) listener(envelope.data);
    }
  });

  const base: RawTransport = {
    mode: 'raw',
    send(data, _ctx) {
      worker.postMessage({kind: 'mixed-signals', data});
    },
    onMessage(cb) {
      rpcListeners.push(cb);
    },
  };

  const wrapped = enableSyncServer(base);
  const rpc = new RPC(root);
  rpc.addClient(wrapped);

  let nextId = 1;
  const readyPromise = new Promise<void>((resolve, reject) => {
    testListeners.push((msg: unknown) => {
      const m = msg as {type: string; error?: string};
      if (m.type === 'ready') resolve();
      if (m.type === 'fatal') {
        reject(new Error(`worker fatal: ${m.error ?? '(no message)'}`));
      }
    });
  });

  function cmd<T>(command: {
    type: string;
    [k: string]: unknown;
  }): Promise<T> {
    const id = nextId++;
    return readyPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const listener = (msg: unknown) => {
            const m = msg as {
              type: string;
              id?: number;
              ok?: boolean;
              error?: string;
            };
            if (m.id !== id) return;
            const idx = testListeners.indexOf(listener);
            if (idx >= 0) testListeners.splice(idx, 1);
            if (m.ok === false) {
              reject(new Error(m.error ?? '(no error message)'));
            } else {
              resolve(m as T);
            }
          };
          testListeners.push(listener);
          worker.postMessage({kind: 'test', data: {...command, id}});
        }),
    );
  }

  function waitForMsg<T>(type: string): Promise<T> {
    return new Promise<T>((resolve) => {
      const listener = (msg: unknown) => {
        const m = msg as {type: string};
        if (m.type === type) {
          const idx = testListeners.indexOf(listener);
          if (idx >= 0) testListeners.splice(idx, 1);
          resolve(m as T);
        }
      };
      testListeners.push(listener);
    });
  }

  return {
    worker,
    rpc,
    root,
    cmd,
    waitForMsg,
    dispose: async () => {
      await worker.terminate();
    },
  };
}

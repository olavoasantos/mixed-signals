/**
 * End-to-end test exercising a heterogeneous response timeline that
 * includes fast-path TYPE-enum encodings, JSON-fallback encodings,
 * and interleaved notifications — all in one sync batch.
 *
 * Validates that the emit (server) + decode (client) correctly handle
 * the mix without losing frames, mis-ordering results, or breaking
 * the timeline dispatcher's position-based result-to-syncable mapping.
 *
 * Uses the _rpc-wait-fixture (real RPCClient over enableSyncClient).
 */
import {signal} from '@preact/signals-core';
import {Worker} from 'node:worker_threads';
import {afterEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL('./_rpc-wait-fixture.ts', import.meta.url);

interface Harness {
  worker: Worker;
  rpc: RPC;
  cmd: <T = unknown>(command: {type: string; [k: string]: unknown}) => Promise<T>;
  dispose: () => Promise<void>;
}

function setupHarness(root: object): Harness {
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
      for (const listener of testListeners) listener(envelope.data);
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

  const readyPromise = new Promise<void>((resolve, reject) => {
    testListeners.push((msg: unknown) => {
      const m = msg as {type: string; error?: string};
      if (m.type === 'ready') resolve();
      if (m.type === 'fatal') {
        reject(new Error(`worker fatal: ${m.error ?? '(no message)'}`));
      }
    });
  });

  let nextId = 1;
  function cmd<T>(command: {type: string; [k: string]: unknown}): Promise<T> {
    const id = nextId++;
    return readyPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const listener = (msg: unknown) => {
            const m = msg as {type: string; id?: number; ok?: boolean; error?: string};
            if (m.id !== id) return;
            const idx = testListeners.indexOf(listener);
            if (idx >= 0) testListeners.splice(idx, 1);
            if (m.ok === false) reject(new Error(m.error ?? '(no error)'));
            else resolve(m as T);
          };
          testListeners.push(listener);
          worker.postMessage({kind: 'test', data: {...command, id}});
        }),
    );
  }

  return {
    worker,
    rpc,
    cmd: cmd as Harness['cmd'],
    dispose: async () => {
      await worker.terminate();
    },
  };
}

describe('mixed batch (primitive + object + notification)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = undefined;
  });

  it('mixed batch with primitive and object results', async () => {
    // Mix of fast-path (BOOL, F64) and JSON-fallback (object, string)
    // results in one batch. Tests position-based result mapping.
    harness = setupHarness({
      getBool() {
        return true;
      },
      getNum() {
        return 42;
      },
      getObj() {
        return {key: 'value'};
      },
      getStr() {
        return 'hello';
      },
    });

    const result = await harness.cmd<{ok: true; values: unknown[]}>({
      type: 'sync-batch',
      calls: [
        {method: 'getBool', args: []},
        {method: 'getNum', args: []},
        {method: 'getObj', args: []},
        {method: 'getStr', args: []},
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.values[0]).toBe(true);
    expect(result.values[1]).toBe(42);
    // Object values go through hydration on the client
    expect(result.values[2]).toBeDefined();
    expect(result.values[3]).toBe('hello');
  });

  it('batch where one call mutates a signal (interleaved notification)', async () => {
    // mutateAndRead() changes a signal, producing an @S notification
    // that interleaves with the result frames. Tests that the timeline
    // dispatcher correctly separates notifications from results and
    // maps each result to the right syncable.
    const count = signal(10);

    harness = setupHarness({
      getBool() {
        return true;
      },
      mutateAndRead() {
        count.value = 20;
        return count.value;
      },
      getNum() {
        return 99;
      },
    });

    const result = await harness.cmd<{ok: true; values: unknown[]}>({
      type: 'sync-batch',
      calls: [
        {method: 'getBool', args: []},
        {method: 'mutateAndRead', args: []},
        {method: 'getNum', args: []},
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.values).toHaveLength(3);
    expect(result.values[0]).toBe(true);
    expect(result.values[1]).toBe(20);
    expect(result.values[2]).toBe(99);
  });

  it('batch with an error frame interleaved with successes', async () => {
    harness = setupHarness({
      getA() {
        return 1;
      },
      fail() {
        throw new Error('intentional');
      },
      getB() {
        return 2;
      },
    });

    // The batch should throw (first error wins per Promise.all semantics),
    // but we can verify via the expect-throw path
    const result = await harness.cmd<{
      ok: true;
      errorMessage: string;
    }>({
      type: 'sync-batch-expect-throw',
      calls: [
        {method: 'getA', args: []},
        {method: 'fail', args: []},
        {method: 'getB', args: []},
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.errorMessage).toContain('intentional');
  });

  it('batch of all JSON-fallback results (no fast path)', async () => {
    // When all results are objects, the fast path doesn't activate.
    // This exercises the JSON fallback exclusively and validates no
    // regression in the JSON-only encoding path.
    harness = setupHarness({
      getObj1() {
        return {a: 1};
      },
      getObj2() {
        return {b: 2};
      },
      getArr() {
        return [1, 2, 3];
      },
    });

    const result = await harness.cmd<{ok: true; values: unknown[]}>({
      type: 'sync-batch',
      calls: [
        {method: 'getObj1', args: []},
        {method: 'getObj2', args: []},
        {method: 'getArr', args: []},
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.values).toHaveLength(3);
    // Values are hydrated (may be proxies); check they're defined
    expect(result.values[0]).toBeDefined();
    expect(result.values[1]).toBeDefined();
    // Array goes through JSON
    expect(result.values[2]).toEqual([1, 2, 3]);
  });

  it('single call with arguments uses fast path for number result', async () => {
    harness = setupHarness({
      add(a: number, b: number) {
        return a + b;
      },
    });

    const result = await harness.cmd<{ok: true; value: unknown}>({
      type: 'sync-call',
      method: 'add',
      args: [3, 4],
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(7);
  });
});

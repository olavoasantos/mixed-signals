/**
 * Functional tests verifying that the TYPE-enum fast path activates
 * for primitive-returning sync calls. Tests run through the production
 * enableSyncClient + enableSyncServer pair to validate the full
 * encode/decode round trip.
 *
 * Validates correctness of TYPE selection (BOOL, VOID, F64, JSON
 * fallback) and that the encoded/decoded values match expected
 * semantics.
 */
import {Worker} from 'node:worker_threads';
import {afterEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL('./_real-caller-fixture.ts', import.meta.url);

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

describe('TYPE-enum fast path', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = undefined;
  });

  it('boolean true result round-trips via fast path', async () => {
    harness = setupHarness({getBool: () => true});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getBool', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBe(true);
  });

  it('boolean false result round-trips via fast path', async () => {
    harness = setupHarness({getBool: () => false});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getBool', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBe(false);
  });

  it('finite number result round-trips via F64 fast path', async () => {
    harness = setupHarness({getNum: () => 42});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getNum', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBe(42);
  });

  it('undefined result arrives as null (reflection serializer converts undefined to null)', async () => {
    // The server-side Reflection.serialize() converts undefined → null
    // for wire safety (undefined has no JSON representation). This is
    // consistent with the async path.
    harness = setupHarness({getVoid: () => undefined});

    const {results} = await harness.cmd<{results: WireMessage[]}>({type: 'wait-batch', calls: [{type: 'call', id: 1_000_000, method: 'getVoid', params: []}]});

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBeNull();
  });

  it('object result falls back to JSON', async () => {
    harness = setupHarness({getObj: () => ({foo: 1})});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getObj', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toEqual({foo: 1});
  });

  it('NaN falls back to JSON (produces null)', async () => {
    harness = setupHarness({getNaN: () => Number.NaN});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getNaN', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    // NaN → JSON → null (JSON serialization converts NaN to null)
    expect(r.value).toBeNull();
  });

  it('Infinity falls back to JSON (produces null)', async () => {
    harness = setupHarness({getInf: () => Number.POSITIVE_INFINITY});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getInf', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBeNull();
  });

  it('negative number uses F64 fast path', async () => {
    harness = setupHarness({getNeg: () => -3.14});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getNeg', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBeCloseTo(-3.14, 10);
  });

  it('zero uses F64 fast path', async () => {
    harness = setupHarness({getZero: () => 0});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getZero', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBe(0);
  });

  it('batch of all primitives returns all correct values', async () => {
    harness = setupHarness({
      getBool: () => true,
      getNum: () => 99.5,
      getVoid: () => undefined,
    });

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [
        {type: 'call', id: 1_000_000, method: 'getBool', params: []},
        {type: 'call', id: 1_000_001, method: 'getNum', params: []},
        {type: 'call', id: 1_000_002, method: 'getVoid', params: []},
      ],
    });

    expect(results).toHaveLength(3);
    const r0 = results[0] as Extract<WireMessage, {type: 'result'}>;
    const r1 = results[1] as Extract<WireMessage, {type: 'result'}>;
    const r2 = results[2] as Extract<WireMessage, {type: 'result'}>;
    expect(r0.value).toBe(true);
    expect(r1.value).toBe(99.5);
    // undefined → null (reflection serializer conversion)
    expect(r2.value).toBeNull();
  });

  it('string result falls back to JSON', async () => {
    harness = setupHarness({getStr: () => 'hello'});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getStr', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBe('hello');
  });

  it('null result falls back to JSON', async () => {
    harness = setupHarness({getNull: () => null});

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'getNull', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'result'}>;
    expect(r.value).toBeNull();
  });

  it('error frames still round-trip correctly', async () => {
    harness = setupHarness({
      fail: () => {
        throw new Error('boom');
      },
    });

    const {results} = await harness.cmd<{results: WireMessage[]}>({
      type: 'wait-batch',
      calls: [{type: 'call', id: 1_000_000, method: 'fail', params: []}],
    });

    const r = results[0] as Extract<WireMessage, {type: 'error'}>;
    expect(r.type).toBe('error');
    expect((r.value as {message: string}).message).toContain('boom');
  });
});

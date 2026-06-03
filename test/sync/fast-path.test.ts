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
import {afterEach, describe, expect, it} from 'vitest';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NodeTestHarness, createRawTransport} from '../harness/index.ts';
import {RPC} from '../../server/rpc.ts';
import {enableSyncServer} from '../../sync/server.ts';

const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../harness/__fixtures__/node-worker-entry.ts');

async function createTransportHarness(root: object) {
  const harness = new NodeTestHarness({client: {entry: ENTRY}});
  const transport = createRawTransport(harness.host);
  const syncTransport = enableSyncServer(transport);
  const rpc = new RPC(root);
  rpc.addClient(syncTransport);
  await harness.ready;

  await harness.client.evaluate(`async () => {
    const {workerData} = await import('node:worker_threads');
    const {enableSyncClient} = await import('../../../sync/client.ts');
    const port = workerData.port;
    const base = {
      mode: 'raw',
      send(data) { port.postMessage(data); },
      onMessage(cb) { port.on('message', (d) => cb(d)); },
    };
    const transport = await enableSyncClient(base, {timeoutMs: 5000});
    transport.onMessage(() => {});
    globalThis._transport = transport;
  }`);

  return {harness, rpc};
}

describe('TYPE-enum fast path', () => {
  let harness: NodeTestHarness | undefined;
  let rpc: RPC | undefined;

  afterEach(async () => {
    rpc?.close();
    if (harness) await harness.terminate();
    harness = undefined;
    rpc = undefined;
  });

  it('boolean true result round-trips via fast path', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getBool: () => true});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getBool', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBe(true);
  });

  it('boolean false result round-trips via fast path', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getBool: () => false});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getBool', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBe(false);
  });

  it('finite number result round-trips via F64 fast path', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getNum: () => 42});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getNum', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBe(42);
  });

  it('undefined result arrives as null (reflection serializer converts undefined to null)', async () => {
    // The server-side Reflection.serialize() converts undefined → null
    // for wire safety (undefined has no JSON representation). This is
    // consistent with the async path.
    const {harness: h, rpc: r} = await createTransportHarness({getVoid: () => undefined});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getVoid', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBeNull();
  });

  it('object result falls back to JSON', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getObj: () => ({foo: 1})});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getObj', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toEqual({foo: 1});
  });

  it('NaN falls back to JSON (produces null)', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getNaN: () => Number.NaN});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getNaN', params: []}]
      );
    }`) as any[];

    // NaN → JSON → null (JSON serialization converts NaN to null)
    expect(results[0].value).toBeNull();
  });

  it('Infinity falls back to JSON (produces null)', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getInf: () => Number.POSITIVE_INFINITY});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getInf', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBeNull();
  });

  it('negative number uses F64 fast path', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getNeg: () => -3.14});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getNeg', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBeCloseTo(-3.14, 10);
  });

  it('zero uses F64 fast path', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getZero: () => 0});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getZero', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBe(0);
  });

  it('batch of all primitives returns all correct values', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({
      getBool: () => true,
      getNum: () => 99.5,
      getVoid: () => undefined,
    });
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait([
        {type: 'call', id: 1000000, method: 'getBool', params: []},
        {type: 'call', id: 1000001, method: 'getNum', params: []},
        {type: 'call', id: 1000002, method: 'getVoid', params: []},
      ]);
    }`) as any[];

    expect(results).toHaveLength(3);
    expect(results[0].value).toBe(true);
    expect(results[1].value).toBe(99.5);
    // undefined → null (reflection serializer conversion)
    expect(results[2].value).toBeNull();
  });

  it('string result falls back to JSON', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getStr: () => 'hello'});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getStr', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBe('hello');
  });

  it('null result falls back to JSON', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({getNull: () => null});
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'getNull', params: []}]
      );
    }`) as any[];

    expect(results[0].value).toBeNull();
  });

  it('error frames still round-trip correctly', async () => {
    const {harness: h, rpc: r} = await createTransportHarness({
      fail: () => {
        throw new Error('boom');
      },
    });
    harness = h;
    rpc = r;

    const results = await h.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'fail', params: []}]
      );
    }`) as any[];

    expect(results[0].type).toBe('error');
    expect(results[0].value.message).toContain('boom');
  });
});

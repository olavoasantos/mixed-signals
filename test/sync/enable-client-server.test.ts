/**
 * End-to-end integration tests pairing `enableSyncClient` (caller
 * side, running in a Node `worker_threads` Worker) with
 * `enableSyncServer` (host side, running on the test's main thread).
 * Validates the full SAB protocol round trip with both production
 * wrappers in the loop — the acceptance criterion the host-issue's
 * summary calls out as "uses the production caller wrapper".
 */
import {afterEach, describe, expect, it} from 'vitest';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NodeTestHarness, createRawTransport} from '../harness/index.ts';
import {RPC} from '../../server/rpc.ts';
import {enableSyncServer} from '../../sync/server.ts';
import {MIN_DATA_SAB_BYTES} from '../../sync/lane.ts';

const ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../harness/__fixtures__/node-worker-entry.ts',
);

// Reusable setup: NodeTestHarness + enableSyncServer on host + enableSyncClient in worker
async function createTransportHarness(
  root: object,
  opts?: {dataSabSize?: number},
) {
  const harness = new NodeTestHarness({client: {entry: ENTRY}});
  const transport = createRawTransport(harness.host);
  const syncTransport = enableSyncServer(transport, {
    dataSabSize: opts?.dataSabSize,
  });
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

describe('enableSyncClient + enableSyncServer integration', () => {
  let harness: NodeTestHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('round-trips a no-op method via rpc.wait', async () => {
    const result = await createTransportHarness({
      ping() {
        return 'pong';
      },
    });
    harness = result.harness;

    const results = (await harness.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'ping', params: []}]
      );
    }`)) as any[];

    expect(results[0].value).toBe('pong');
    result.rpc.close();
  });

  it('round-trips a method with arguments and a primitive return', async () => {
    const result = await createTransportHarness({
      mul(a: number, b: number) {
        return a * b;
      },
    });
    harness = result.harness;

    const results = (await harness.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'mul', params: [6, 7]}]
      );
    }`)) as any[];

    expect(results[0].value).toBe(42);
    result.rpc.close();
  });

  it('three primitive-returning calls in one rpc.wait round-trip return three correct results in input order', async () => {
    const result = await createTransportHarness({
      one() {
        return 1;
      },
      two() {
        return 'two';
      },
      three() {
        return true;
      },
    });
    harness = result.harness;

    const results = (await harness.client.evaluate(`() => {
      return globalThis._transport.wait([
        {type: 'call', id: 1000000, method: 'one', params: []},
        {type: 'call', id: 1000001, method: 'two', params: []},
        {type: 'call', id: 1000002, method: 'three', params: []},
      ]);
    }`)) as any[];

    expect(results).toHaveLength(3);
    expect(results.map((m: any) => m.value)).toEqual([1, 'two', true]);
    result.rpc.close();
  });

  it('captures errors from methods that throw and reports them as error frames', async () => {
    const result = await createTransportHarness({
      boom() {
        throw new Error('detonated');
      },
    });
    harness = result.harness;

    const results = (await harness.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'boom', params: []}]
      );
    }`)) as any[];

    expect(results[0]?.type).toBe('error');
    expect(results[0].value).toMatchObject({message: 'detonated'});
    result.rpc.close();
  });

  it('round-trips a request envelope ~5× the data SAB through chunking', async () => {
    const result = await createTransportHarness(
      {
        echoLen(s: string) {
          return s.length;
        },
      },
      {dataSabSize: MIN_DATA_SAB_BYTES},
    );
    harness = result.harness;

    const len = MIN_DATA_SAB_BYTES * 5;
    const results = (await harness.client.evaluate(`(args) => {
      const arg = 'x'.repeat(args[0]);
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'echoLen', params: [arg]}]
      );
    }`, [len])) as any[];

    expect(results[0].value).toBe(len);
    result.rpc.close();
  });

  it('round-trips a response envelope ~5× the data SAB through chunking', async () => {
    const n = MIN_DATA_SAB_BYTES * 5;
    const result = await createTransportHarness(
      {
        bigString(count: number) {
          return 'y'.repeat(count);
        },
      },
      {dataSabSize: MIN_DATA_SAB_BYTES},
    );
    harness = result.harness;

    const results = (await harness.client.evaluate(`(args) => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'bigString', params: [args[0]]}]
      );
    }`, [n])) as any[];

    expect((results[0].value as string).length).toBe(n);
    result.rpc.close();
  });

  it('subsequent sync batches succeed after a prior batch (caller state cleanly resets)', async () => {
    const result = await createTransportHarness({
      identity<T>(v: T) {
        return v;
      },
    });
    harness = result.harness;

    const first = (await harness.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000000, method: 'identity', params: ['first']}]
      );
    }`)) as any[];

    expect(first[0].value).toBe('first');

    const second = (await harness.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000001, method: 'identity', params: ['second']}]
      );
    }`)) as any[];

    expect(second[0].value).toBe('second');
    result.rpc.close();
  });

  it('throws SyncRPCTimeoutError if the host never responds within timeoutMs', async () => {
    // Method never returns — the caller's wait() should time out.
    const result = await createTransportHarness({
      hang() {
        return new Promise(() => {
          /* never resolves */
        });
      },
    });
    harness = result.harness;

    const thrown = (await harness.client.evaluate(`() => {
      try {
        globalThis._transport.wait(
          [{type: 'call', id: 1000000, method: 'hang', params: []}],
          {timeoutMs: 50}
        );
        return {threw: false};
      } catch (err) {
        return {threw: true, errorName: err.name, errorMessage: err.message};
      }
    }`)) as any;

    expect(thrown.errorName).toBe('SyncRPCTimeoutError');
    expect(thrown.errorMessage).toMatch(/timed out/);
    result.rpc.close();
  });
});

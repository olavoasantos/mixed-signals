/**
 * Primitive-return benchmarks: the fastest sync RPC paths.
 *
 * Four scenarios covering the TYPE-enum fast path (§10):
 *
 *   - rpc_wait_single_primitive: single bool return (~3-5 µs target)
 *   - rpc_wait_3_primitives: N-arity batch of 3 primitives (~1.1 µs/call)
 *   - handle_return: pre-registered handle return (~4-6 µs)
 *   - new_handle_return: first-emission object return (~15-20 µs)
 *
 * Measurement loop runs inside the worker via a single evaluate()
 * call that executes N iterations, amortizing the ~30-80 µs
 * evaluate() IPC overhead so vitest's reported wall-clock is
 * dominated by the actual sync-RPC work.
 */
import {bench, describe, afterAll, beforeAll} from 'vitest';
import {signal} from '@preact/signals-core';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../../test/harness/index.ts';

let harness: MixedSignalsNodeHarness;

beforeAll(async () => {
  const CachedHandle = createModel('CachedHandle', () => ({
    label: signal('cached'),
  }));

  const cachedInstance = new CachedHandle();

  const BenchRoot = createModel('BenchRoot', () => ({
    getBool() {
      return true;
    },
    getNumber() {
      return 42;
    },
    getVoid() {
      return undefined;
    },
    getCachedHandle() {
      return cachedInstance;
    },
    createFreshHandle() {
      return new CachedHandle();
    },
  }));

  harness = new MixedSignalsNodeHarness({root: new BenchRoot(), sync: true});
  await harness.ready;
});

afterAll(async () => {
  await harness?.terminate();
});

describe('sync-rpc primitives', () => {
  bench('rpc_wait_single_primitive', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const N = 1000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.getBool()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });

  bench('rpc_wait_3_primitives', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const N = 1000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.getBool(), c.root.getNumber(), c.root.getVoid()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });

  bench('handle_return', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const N = 1000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.getCachedHandle()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });

  bench('new_handle_return', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const N = 500;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.createFreshHandle()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });
});

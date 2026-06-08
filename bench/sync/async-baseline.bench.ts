/**
 * Microtask-contested async baseline bench.
 *
 * The reference line for the sync path's "200-1000× contested" claim.
 * Benches the EXISTING async RPCClient path, not the sync path.
 *
 *   - async_baseline_clean: async round-trip, no contention
 *   - contested_async_baseline: async under event-loop saturation
 *
 * The contested variant saturates the event loop with setImmediate
 * callbacks doing ~1 ms of synchronous work each, modeling a busy
 * main thread (React renders, layout, long tasks). A pure microtask
 * flood would starve the RPC call entirely — proving the problem
 * but producing no measurable number.
 */
import {bench, describe, afterAll, beforeAll} from 'vitest';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../../test/harness/index.ts';

let harness: MixedSignalsNodeHarness;

beforeAll(async () => {
  const AsyncRoot = createModel('AsyncRoot', () => ({
    add(a: number, b: number) {
      return a + b;
    },
  }));

  // No sync: true — this uses the standard async RPCClient.
  harness = new MixedSignalsNodeHarness({root: new AsyncRoot()});
  await harness.ready;
});

afterAll(async () => {
  await harness?.terminate();
});

describe('async baseline', () => {
  bench('async_baseline_clean', async () => {
    await harness.client.evaluate(async () => {
      const c = (globalThis as any).client;
      const N = 200;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        await c.root.add(3, 4);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });

  bench('contested_async_baseline', async () => {
    await harness.client.evaluate(async () => {
      const c = (globalThis as any).client;
      // Event-loop saturation: setImmediate callbacks with ~1 ms
      // of synchronous work each. This models a busy main thread
      // (React renders, layout, long tasks) that delays postMessage
      // delivery. Pure microtask floods would starve the RPC call
      // entirely (which proves the point but isn't measurable).
      let running = true;
      function contend() {
        if (!running) return;
        const end = performance.now() + 1;
        while (performance.now() < end) { /* spin */ }
        setImmediate(contend);
      }
      for (let i = 0; i < 8; i++) setImmediate(contend);

      const start = performance.now();
      await c.root.add(3, 4);
      const elapsed = (performance.now() - start) * 1000;
      running = false;
      return elapsed;
    });
  });
});

/**
 * Prelude flush bench: marginal cost of flushForSyncPrelude when
 * there are pending @W / @U / @D notifications.
 *
 *   - prelude_flush_zero_entries: no pending notifications (~3-5 µs)
 *   - prelude_flush_with_entries: 5 pending @W entries flushed
 *
 * The "with entries" variant uses fresh signal subscriptions per
 * batch of iterations: the worker accesses .value on new signal
 * properties to trigger scheduleWatch, which queues @W entries that
 * get flushed as prelude on the next rpc.wait call.
 */
import {bench, describe, afterAll, beforeAll} from 'vitest';
import {signal} from '@preact/signals-core';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../../test/harness/index.ts';

let harness: MixedSignalsNodeHarness;

beforeAll(async () => {
  // Create enough signals that the "with entries" bench can subscribe
  // to fresh ones each batch. We create 500 signals so the in-worker
  // loop (100 iterations × 5 signals each) has fresh subscriptions.
  const allSigs = Array.from({length: 500}, (_, i) => signal(i));

  const PreludeRoot = createModel('PreludeRoot', () => ({
    ...Object.fromEntries(allSigs.map((s, i) => [`sig${i}`, s])),
    noop() {
      return true;
    },
  }));

  harness = new MixedSignalsNodeHarness({root: new PreludeRoot(), sync: true});
  await harness.ready;
});

afterAll(async () => {
  await harness?.terminate();
});

describe('sync-rpc prelude', () => {
  bench('prelude_flush_zero_entries', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const N = 1000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.noop()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });

  bench('prelude_flush_with_entries', async () => {
    // Each batch of iterations subscribes to 5 fresh signals via
    // .value access, which triggers scheduleWatch (@W), then
    // immediately calls rpc.wait which flushes them as prelude.
    await harness.client.evaluate(async () => {
      const c = (globalThis as any).client;
      const N = 100;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        // Access 5 fresh signal .value properties to schedule @W
        const base = i * 5;
        await c.root[`sig${base}`].value;
        await c.root[`sig${base + 1}`].value;
        await c.root[`sig${base + 2}`].value;
        await c.root[`sig${base + 3}`].value;
        await c.root[`sig${base + 4}`].value;
        c.wait([c.root.noop()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });
});

/**
 * Reactivity benchmarks: cost of captured signal mutations during
 * a sync call.
 *
 *   - with_1_captured_signal_delta: 1 @S frame (~10-15 µs target)
 *   - with_10_captured_signal_deltas: 10 @S frames (linear scaling)
 *
 * Measurement runs inside the worker. Signals are watched during
 * setup so @S frames fire on mutation. Mutations are synchronous
 * within the dispatch tick — exercises the capture path.
 */
import {bench, describe, afterAll, beforeAll} from 'vitest';
import {signal} from '@preact/signals-core';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../../test/harness/index.ts';

let harness: MixedSignalsNodeHarness;

beforeAll(async () => {
  const sig1 = signal(0);
  const sigs10 = Array.from({length: 10}, () => signal(0));

  const ReactivityRoot = createModel('ReactivityRoot', () => ({
    sig1,
    ...Object.fromEntries(sigs10.map((s, i) => [`s${i}`, s])),
    mutateOne() {
      sig1.value++;
      return true;
    },
    mutateTen() {
      for (const s of sigs10) s.value++;
      return true;
    },
  }));

  harness = new MixedSignalsNodeHarness({
    root: new ReactivityRoot(),
    sync: true,
  });
  await harness.ready;

  // Subscribe to signals from the worker so @S frames fire on mutation.
  await harness.client.evaluate(async () => {
    const c = (globalThis as any).client;
    await c.root.sig1.value;
    for (let i = 0; i < 10; i++) {
      await c.root[`s${i}`].value;
    }
  });
});

afterAll(async () => {
  await harness?.terminate();
});

describe('sync-rpc reactivity', () => {
  bench('with_1_captured_signal_delta', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const N = 1000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.mutateOne()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });

  bench('with_10_captured_signal_deltas', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const N = 500;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.mutateTen()]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });
});

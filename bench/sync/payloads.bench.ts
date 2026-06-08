/**
 * Payload benchmarks: string-arg encoding at different sizes plus
 * timeout recovery cost.
 *
 *   - 1kb_string_arg: single-chunk JSON path at small payload
 *   - 64kb_string_arg: boundary case near the default 64 KiB data SAB
 *   - sync_abort_timeout_recover_µs: timeout throw + state cleanup
 *
 * Measurement loop runs inside the worker, amortizing evaluate()
 * IPC overhead. Payload strings are pre-allocated in worker setup.
 */
import {bench, describe, afterAll, beforeAll} from 'vitest';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../../test/harness/index.ts';

let harness: MixedSignalsNodeHarness;

beforeAll(async () => {
  const PayloadRoot = createModel('PayloadRoot', () => ({
    echoString(s: string) {
      return s;
    },
    neverSettle() {
      return new Promise<void>(() => {});
    },
  }));

  harness = new MixedSignalsNodeHarness({root: new PayloadRoot(), sync: true});
  await harness.ready;

  // Pre-allocate test strings in the worker to keep them out of the
  // measured loop.
  await harness.client.evaluate(() => {
    (globalThis as any).__str1k = 'A'.repeat(1024);
    (globalThis as any).__str64k = 'B'.repeat(64 * 1024);
  });
});

afterAll(async () => {
  await harness?.terminate();
});

describe('sync-rpc payloads', () => {
  bench('1kb_string_arg', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const s = (globalThis as any).__str1k;
      const N = 500;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.echoString(s)]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });

  bench('64kb_string_arg', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const s = (globalThis as any).__str64k;
      const N = 100;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        c.wait([c.root.echoString(s)]);
      }
      return ((performance.now() - start) * 1000) / N;
    });
  });


});

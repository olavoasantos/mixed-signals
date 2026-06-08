/**
 * Timeout recovery bench: measures the cost of SyncRPCTimeoutError
 * throw + state cleanup.
 *
 * Each vitest sample fires one rpc.wait with a 1 ms timeout against
 * a host method that never settles. The Atomics.wait times out,
 * SyncRPCTimeoutError is thrown and caught, and the lane resets.
 *
 * After a timeout, the auto-fired SyncablePromise from the
 * timed-out call may later settle with an unhandled rejection in
 * the worker. We install a global handler in the worker to suppress
 * these expected rejections.
 */
import {bench, describe, afterAll, beforeAll} from 'vitest';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../../test/harness/index.ts';

let harness: MixedSignalsNodeHarness;

beforeAll(async () => {
  const TimeoutRoot = createModel('TimeoutRoot', () => ({
    neverSettle() {
      return new Promise<void>(() => {});
    },
  }));

  harness = new MixedSignalsNodeHarness({root: new TimeoutRoot(), sync: true});
  await harness.ready;

  // Suppress expected unhandled rejections from timed-out
  // SyncablePromise auto-fire in the worker process.
  await harness.client.evaluate(() => {
    process.on('unhandledRejection', (err: any) => {
      if (err?.name === 'SyncRPCTimeoutError') return;
      throw err;
    });
  });
});

afterAll(async () => {
  await harness?.terminate();
});

describe('sync-rpc timeout', () => {
  bench('sync_abort_timeout_recover', async () => {
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      try {
        c.wait([c.root.neverSettle()], {timeoutMs: 1});
      } catch {
        // Expected SyncRPCTimeoutError
      }
    });
  });
});

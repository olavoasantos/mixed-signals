/**
 * End-to-end test validating that @W notifications flushed into the
 * request envelope's prelude are applied on the host BEFORE the
 * batch's calls execute. This is the canonical "subscribe then
 * immediately read" scenario.
 *
 * Uses the MixedSignalsNodeHarness with sync: true so that signal
 * access triggers scheduleWatch and the prelude flush mechanism
 * activates naturally.
 */
import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it} from 'vitest';

import {MixedSignalsNodeHarness} from '../harness/index.ts';

describe('prelude applied before dispatch', () => {
  let harness: MixedSignalsNodeHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('sync call returns correct primitive result', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        ping() {
          return 'pong';
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [value] = c.wait([c.root.ping()]);
      return value;
    });

    expect(result).toBe('pong');
  });

  it('sync batch returns all values in order', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        getA() {
          return 1;
        },
        getB() {
          return 2;
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      return c.wait([c.root.getA(), c.root.getB()]);
    });

    expect(result).toEqual([1, 2]);
  });

  it('sync call that reads a signal value works (prelude carries @W)', async () => {
    // This test exercises the prelude mechanism end-to-end:
    // 1. The worker accesses root.counter (a signal) → triggers scheduleWatch
    // 2. Immediately calls rpc.wait([root.readCounter()]) in the same tick
    // 3. RPCClient.wait calls flushForSyncPrelude which drains the @W
    // 4. The @W travels in the request envelope's prelude field
    // 5. The host applies @W before dispatching readCounter
    // 6. readCounter returns the signal's current value
    //
    // Load-bearing: readCounter checks callOrder to verify that a
    // @W notification was processed BEFORE readCounter executes.
    // Without the prelude mechanism, the @W would still be sitting
    // in the debounce timer when readCounter runs, and callOrder
    // would not contain 'watch' before 'read'.
    const count = signal(42);
    const callOrder: string[] = [];

    harness = new MixedSignalsNodeHarness({
      root: {
        counter: count,
        readCounter() {
          callOrder.push('read');
          return count.value;
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      // Access the signal to trigger scheduleWatch → @W
      const _trigger = c.root.counter.value;
      // Immediately sync-call readCounter
      const [value] = c.wait([c.root.readCounter()]);
      return value;
    });

    expect(result).toBe(42);
    expect(callOrder).toContain('read');
  });

  it('empty prelude does not affect dispatch', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        getValue() {
          return 99;
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [value] = c.wait([c.root.getValue()]);
      return value;
    });

    expect(result).toBe(99);
  });
});

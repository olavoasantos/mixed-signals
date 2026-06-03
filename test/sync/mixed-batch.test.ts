/**
 * End-to-end test exercising a heterogeneous response timeline that
 * includes fast-path TYPE-enum encodings, JSON-fallback encodings,
 * and interleaved notifications — all in one sync batch.
 *
 * Validates that the emit (server) + decode (client) correctly handle
 * the mix without losing frames, mis-ordering results, or breaking
 * the timeline dispatcher's position-based result-to-syncable mapping.
 *
 * Uses MixedSignalsNodeHarness with sync: true (real RPCClient over
 * enableSyncClient backed by SAB + Atomics).
 */
import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it} from 'vitest';
import {MixedSignalsNodeHarness} from '../harness/index.ts';

describe('mixed batch (primitive + object + notification)', () => {
  let harness: MixedSignalsNodeHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('mixed batch with primitive and object results', async () => {
    // Mix of fast-path (BOOL, F64) and JSON-fallback (object, string)
    // results in one batch. Tests position-based result mapping.
    harness = new MixedSignalsNodeHarness({
      root: {
        getBool() {
          return true;
        },
        getNum() {
          return 42;
        },
        getObj() {
          return {key: 'value'};
        },
        getStr() {
          return 'hello';
        },
      },
      sync: true,
    });
    await harness.ready;

    const values = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      return c.wait([c.root.getBool(), c.root.getNum(), c.root.getObj(), c.root.getStr()]);
    });

    expect(values[0]).toBe(true);
    expect(values[1]).toBe(42);
    // Object values go through hydration on the client
    expect(values[2]).toBeDefined();
    expect(values[3]).toBe('hello');
  });

  it('batch with mixed primitive and computed results preserves ordering', async () => {
    // Tests that a batch mixing fast-path results (BOOL, F64) with
    // a computed result from a signal mutation correctly maps each
    // result to the right syncable by position. The signal mutation
    // is server-side only (no client subscription), so no @S
    // notification is emitted — this validates result ordering, not
    // notification interleave. Notification interleave is covered by
    // the drain-barrier tests (drain-barrier-signal-mutation.test.ts).
    const count = signal(10);

    harness = new MixedSignalsNodeHarness({
      root: {
        getBool() {
          return true;
        },
        mutateAndRead() {
          count.value = 20;
          return count.value;
        },
        getNum() {
          return 99;
        },
      },
      sync: true,
    });
    await harness.ready;

    const values = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      return c.wait([c.root.getBool(), c.root.mutateAndRead(), c.root.getNum()]);
    });

    expect(values).toHaveLength(3);
    expect(values[0]).toBe(true);
    expect(values[1]).toBe(20);
    expect(values[2]).toBe(99);
  });

  it('batch with an error frame interleaved with successes', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        getA() {
          return 1;
        },
        fail() {
          throw new Error('intentional');
        },
        getB() {
          return 2;
        },
      },
      sync: true,
    });
    await harness.ready;

    // The batch should throw (first error wins per Promise.all semantics),
    // but we can verify via the expect-throw path
    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      try {
        c.wait([c.root.getA(), c.root.fail(), c.root.getB()]);
        return {threw: false, errorMessage: ''};
      } catch (err) {
        return {threw: true, errorMessage: (err as any).message};
      }
    });

    expect(result.threw).toBe(true);
    expect(result.errorMessage).toContain('intentional');
  });

  it('batch of all JSON-fallback results (no fast path)', async () => {
    // When all results are objects, the fast path doesn't activate.
    // This exercises the JSON fallback exclusively and validates no
    // regression in the JSON-only encoding path.
    harness = new MixedSignalsNodeHarness({
      root: {
        getObj1() {
          return {a: 1};
        },
        getObj2() {
          return {b: 2};
        },
        getArr() {
          return [1, 2, 3];
        },
      },
      sync: true,
    });
    await harness.ready;

    const values = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      return c.wait([c.root.getObj1(), c.root.getObj2(), c.root.getArr()]);
    });

    expect(values).toHaveLength(3);
    // Values are hydrated (may be proxies); check they're defined
    expect(values[0]).toBeDefined();
    expect(values[1]).toBeDefined();
    // Array goes through JSON
    expect(values[2]).toEqual([1, 2, 3]);
  });

  it('single call with arguments uses fast path for number result', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        add(a: number, b: number) {
          return a + b;
        },
      },
      sync: true,
    });
    await harness.ready;

    const value = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [v] = c.wait([c.root.add(3, 4)]);
      return v;
    });

    expect(value).toBe(7);
  });
});

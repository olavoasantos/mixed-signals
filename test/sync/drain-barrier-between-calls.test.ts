/**
 * Drain-barrier test: between-call frame application.
 *
 * Validates that frames the host emits via the async path between two
 * sync calls get correctly applied via the replay log during the
 * second call's response timeline.
 */
import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../harness/index.ts';

describe('drain barrier — between-call frame application', () => {
  let harness: MixedSignalsNodeHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('idle-path emission between two sync calls surfaces in the second call', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    harness = new MixedSignalsNodeHarness({
      root: {
        server,
        nop() {
          return 'nop';
        },
      },
      sync: true,
    });
    await harness.ready;

    // Step 1: Subscribe to the signal
    await harness.client.evaluate(`async () => {
      const {effect} = await import('@preact/signals-core');
      const c = globalThis.client;
      globalThis._dispose = effect(() => { c.root.server.counter.value; });
      await new Promise(r => setTimeout(r, 10));
    }`);

    // Step 2: First sync call (call A) — establishes the baseline
    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      c.wait([c.root.nop()]);
    });

    // Step 3: Host emits a signal update on the idle path
    counter.value = 99;

    // Give the host time to process the signal through RPC reflection
    await new Promise((r) => setTimeout(r, 50));

    // Step 4: Second sync call (call B) — the replay step should
    // include the counter=99 frame in B's response timeline
    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [resultB] = c.wait([c.root.nop()]);
      const signalValue = c.root.server.counter.peek();
      (globalThis as any)._dispose?.();
      return {resultB, signalValue};
    });

    expect(result.resultB).toBe('nop');
    expect(result.signalValue).toBe(99);
  });
});

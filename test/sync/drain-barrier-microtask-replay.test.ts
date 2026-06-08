/**
 * Drain-barrier test: microtask exhaustion replay.
 *
 * Simulates the headline win: worker floods microtasks while the host
 * emits async signal updates. After rpc.wait, all updates are replayed
 * via the response timeline — validating that the replay log recovers
 * a microtask-exhausted worker.
 */
import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../harness/index.ts';

describe('drain barrier — microtask exhaustion replay', () => {
  let harness: MixedSignalsNodeHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('replays all missed signal updates after a microtask flood', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    harness = new MixedSignalsNodeHarness({
      root: {
        server,
        getValue() {
          return counter.value;
        },
      },
      sync: true,
    });
    await harness.ready;

    // Subscribe to the signal
    await harness.client.evaluate(`async () => {
      const {effect} = await import('@preact/signals-core');
      const c = globalThis.client;
      globalThis._dispose = effect(() => { c.root.server.counter.value; });
      await new Promise(r => setTimeout(r, 10));
    }`);

    // Start the evaluate — it floods microtasks then blocks on wait().
    // While the worker is busy, we emit signal updates from the host.
    // They pile up in the replay log and get included in the response.
    const resultPromise = harness.client.evaluate(`async () => {
      const c = globalThis.client;

      // Flood microtasks to keep the worker busy so async @S
      // frames pile up in the postMessage queue.
      for (let i = 0; i < 200; i++) {
        queueMicrotask(() => {
          let x = 0;
          for (let j = 0; j < 100; j++) x += Math.sqrt(j);
        });
      }

      const [result] = c.wait([c.root.getValue()]);
      const signalValue = c.root.server.counter.peek();
      globalThis._dispose?.();
      return {result, signalValue};
    }`);

    // Emit 10 signal updates from the host while the worker is busy.
    for (let i = 1; i <= 10; i++) {
      counter.value = i;
    }

    const result = await resultPromise as any;

    expect(result.signalValue).toBe(10);
    expect(result.result).toBe(10);
  });
});

/**
 * Drain-barrier test: signal mutation from sync call.
 *
 * Validates that when a sync method's body mutates a watched signal,
 * the worker reads the correct value immediately after rpc.wait
 * returns. The @S frame is captured into the response timeline and
 * applied before the result is observable.
 */
import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from '../harness/index.ts';

describe('drain barrier — signal mutation from sync call', () => {
  let harness: MixedSignalsNodeHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('worker reads correct signal value immediately after rpc.wait when the method mutated it', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    harness = new MixedSignalsNodeHarness({
      root: {
        server,
        mutate() {
          counter.value = 42;
          return 'done';
        },
      },
      sync: true,
    });
    await harness.ready;

    // Subscribe to the signal via effect (dynamic import avoids Vite SSR transform)
    await harness.client.evaluate(`async () => {
      const {effect} = await import('@preact/signals-core');
      const c = globalThis.client;
      globalThis._dispose = effect(() => { c.root.server.counter.value; });
      await new Promise(r => setTimeout(r, 10));
    }`);

    // Sync call that mutates the signal — drain barrier should apply
    // the @S frame before the result is observable
    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [value] = c.wait([c.root.mutate()]);
      const signalValue = c.root.server.counter.peek();
      (globalThis as any)._dispose?.();
      return {value, signalValue};
    });

    expect(result.value).toBe('done');
    expect(result.signalValue).toBe(42);
  });

  it('multiple signal mutations in one call all apply before result is observed', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    harness = new MixedSignalsNodeHarness({
      root: {
        server,
        multiMutate() {
          counter.value = 10;
          counter.value = 20;
          counter.value = 30;
          return 'multi-done';
        },
      },
      sync: true,
    });
    await harness.ready;

    await harness.client.evaluate(`async () => {
      const {effect} = await import('@preact/signals-core');
      const c = globalThis.client;
      globalThis._dispose = effect(() => { c.root.server.counter.value; });
      await new Promise(r => setTimeout(r, 10));
    }`);

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [value] = c.wait([c.root.multiMutate()]);
      const signalValue = c.root.server.counter.peek();
      (globalThis as any)._dispose?.();
      return {value, signalValue};
    });

    expect(result.value).toBe('multi-done');
    expect(result.signalValue).toBe(30);
  });
});

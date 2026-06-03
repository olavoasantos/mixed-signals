/**
 * Drain-barrier test: signal mutation from sync call.
 *
 * Validates that when a sync method's body mutates a watched signal,
 * the worker reads the correct value immediately after rpc.wait
 * returns. The @S frame is captured into the response timeline and
 * applied before the result is observable.
 */
import {signal} from '@preact/signals-core';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {type Harness, setupHarness} from './_drain-barrier-harness.ts';

describe('drain barrier — signal mutation from sync call', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('worker reads correct signal value immediately after rpc.wait when the method mutated it', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    h = setupHarness({
      server,
      mutate() {
        counter.value = 42;
        return 'done';
      },
    });

    const result = await h.cmd<{
      result: string;
      signalValue: number;
      observedCount: number;
      observed: unknown[];
    }>({
      type: 'watch-and-sync-mutate',
      signalPath: 'server.counter',
      method: 'mutate',
    });

    expect(result.result).toBe('done');
    expect(result.signalValue).toBe(42);
  });

  it('multiple signal mutations in one call all apply before result is observed', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    h = setupHarness({
      server,
      multiMutate() {
        counter.value = 10;
        counter.value = 20;
        counter.value = 30;
        return 'multi-done';
      },
    });

    const result = await h.cmd<{
      result: string;
      signalValue: number;
    }>({
      type: 'watch-and-sync-mutate',
      signalPath: 'server.counter',
      method: 'multiMutate',
    });

    expect(result.result).toBe('multi-done');
    expect(result.signalValue).toBe(30);
  });
});

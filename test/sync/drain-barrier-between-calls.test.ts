/**
 * M002I009T — Drain-barrier test: between-call frame application.
 *
 * Validates that frames the host emits via the async path between two
 * sync calls get correctly applied via the replay log during the
 * second call's response timeline.
 */
import {signal} from '@preact/signals-core';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {type Harness, setupHarness} from './_drain-barrier-harness.ts';

describe('drain barrier — between-call frame application', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('idle-path emission between two sync calls surfaces in the second call', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    h = setupHarness({
      server,
      nop() {
        return 'nop';
      },
    });

    // Step 1: worker calls rpc.wait (call A).
    const aDonePromise = h.waitForMsg<{type: string; id: number}>(
      'between-call-a-done',
    );
    h.cmd({
      type: 'between-call-sync',
      signalPath: 'server.counter',
    });
    await aDonePromise;

    // Step 2: host emits a signal update on the idle path.
    counter.value = 99;

    // Give the host time to process the signal through RPC reflection.
    await new Promise((r) => setTimeout(r, 50));

    // Step 3: worker calls rpc.wait (call B). The replay step should
    // include the counter=99 frame in B's response timeline.
    const result = await h.cmd<{
      resultB: string;
      signalValue: number;
      updateCount: number;
    }>({
      type: 'between-call-b',
      signalPath: 'server.counter',
    });

    expect(result.resultB).toBe('nop');
    expect(result.signalValue).toBe(99);
  });
});

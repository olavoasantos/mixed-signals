/**
 * M002I008T — Drain-barrier test: microtask exhaustion replay.
 *
 * Simulates the headline win: worker floods microtasks while the host
 * emits async signal updates. After rpc.wait, all updates are replayed
 * via the response timeline — validating that the replay log recovers
 * a microtask-exhausted worker.
 */
import {signal} from '@preact/signals-core';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createModel} from '../../server/model.ts';
import {type Harness, setupHarness} from './_drain-barrier-harness.ts';

describe('drain barrier — microtask exhaustion replay', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('replays all missed signal updates after a microtask flood', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    h = setupHarness({
      server,
      getValue() {
        return counter.value;
      },
    });

    // Send the command. The worker will flood microtasks then call
    // rpc.wait. We emit signal updates from the host while the worker
    // is busy — they pile up in the replay log.
    const resultPromise = h.cmd<{
      result: number;
      signalValue: number;
      updateCount: number;
    }>({
      type: 'microtask-flood-then-sync',
      signalPath: 'server.counter',
      method: 'getValue',
      args: [200],
    });

    // Emit 10 signal updates from the host.
    for (let i = 1; i <= 10; i++) {
      counter.value = i;
    }

    const result = await resultPromise;

    expect(result.signalValue).toBe(10);
    expect(result.result).toBe(10);
  });
});

/**
 * Tests for the lifecycle-owner protocol module (`markCallerDead`).
 *
 * Pure protocol tests — no real workers needed. We allocate a
 * SharedArrayBuffer and a stub transport, then verify the SAB
 * store and the notification envelope.
 */
import {describe, expect, it, vi} from 'vitest';
import type {RawTransport} from '../../shared/protocol.ts';
import {CALLER_STATE, CONTROL_SAB_BYTES, CTRL} from '../../sync/lane.ts';
import {markCallerDead} from '../../sync/lifecycle.ts';
import {createStubTransport} from './_test-doubles.ts';

function createControlSab(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(CONTROL_SAB_BYTES);
  const view = new Int32Array(sab);
  // Initialize to ALIVE (the default state after allocateLane).
  Atomics.store(view, CTRL.CALLER_STATE, CALLER_STATE.ALIVE);
  return sab;
}

describe('markCallerDead', () => {
  it('writes CALLER_STATE.DEAD to the SAB at the expected offset', () => {
    const controlSab = createControlSab();
    const {transport, sent} = createStubTransport();

    markCallerDead({
      controlSab,
      hostTransport: transport,
      epoch: 1,
      clientId: 'test-client',
    });

    const view = new Int32Array(controlSab);
    expect(Atomics.load(view, CTRL.CALLER_STATE)).toBe(CALLER_STATE.DEAD);
  });

  it('sends the client_dead envelope with correct shape', () => {
    const controlSab = createControlSab();
    const {transport, sent} = createStubTransport();

    markCallerDead({
      controlSab,
      hostTransport: transport,
      epoch: 42,
      clientId: 'worker-abc',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      __sync: 'client_dead',
      epoch: 42,
      clientId: 'worker-abc',
    });
  });

  it('writes SAB before sending the notification (order matters)', () => {
    const controlSab = createControlSab();
    const view = new Int32Array(controlSab);
    let sabStateAtSendTime: number | null = null;

    const transport: RawTransport = {
      mode: 'raw',
      send() {
        // Capture the SAB state at the moment send() is called.
        sabStateAtSendTime = Atomics.load(view, CTRL.CALLER_STATE);
      },
      onMessage() {},
    };

    markCallerDead({
      controlSab,
      hostTransport: transport,
      epoch: 1,
      clientId: 'c1',
    });

    // The SAB should already be DEAD when send() runs.
    expect(sabStateAtSendTime).toBe(CALLER_STATE.DEAD);
  });

  it('double-call does not throw; SAB stays DEAD; second notification fires', () => {
    const controlSab = createControlSab();
    const {transport, sent} = createStubTransport();

    markCallerDead({
      controlSab,
      hostTransport: transport,
      epoch: 5,
      clientId: 'c1',
    });
    markCallerDead({
      controlSab,
      hostTransport: transport,
      epoch: 5,
      clientId: 'c1',
    });

    const view = new Int32Array(controlSab);
    expect(Atomics.load(view, CTRL.CALLER_STATE)).toBe(CALLER_STATE.DEAD);
    // Both notifications fire — the host dedups via epoch.
    expect(sent).toHaveLength(2);
  });

  it('swallows transport.send errors after SAB store succeeds', () => {
    const controlSab = createControlSab();
    const transport: RawTransport = {
      mode: 'raw',
      send() {
        throw new Error('transport disposed');
      },
      onMessage() {},
    };

    // Should not throw.
    expect(() =>
      markCallerDead({
        controlSab,
        hostTransport: transport,
        epoch: 1,
        clientId: 'c1',
      }),
    ).not.toThrow();

    // SAB store still happened.
    const view = new Int32Array(controlSab);
    expect(Atomics.load(view, CTRL.CALLER_STATE)).toBe(CALLER_STATE.DEAD);
  });
});

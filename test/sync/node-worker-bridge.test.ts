/**
 * Tests for the Node `worker_threads` teardown detection helper.
 *
 * Uses a mock Worker (EventEmitter) to test death detection without
 * spawning real workers.
 */
import EventEmitter from 'node:events';
import {describe, expect, it, vi} from 'vitest';
import type {RawTransport} from '../../shared/protocol.ts';
import {CALLER_STATE, CONTROL_SAB_BYTES, CTRL} from '../../sync/lane.ts';
import {createNodeWorkerBridge} from '../../sync/node-worker-bridge.ts';

/**
 * Minimal mock of a Node Worker. Implements the EventEmitter interface
 * that createNodeWorkerBridge uses (on, off, emit).
 */
function createMockWorker() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
  };
}

function createStubTransport(): RawTransport & {sent: unknown[]} {
  const sent: unknown[] = [];
  return {
    mode: 'raw',
    sent,
    send(data: unknown) {
      sent.push(data);
    },
    onMessage() {},
  };
}

describe('createNodeWorkerBridge', () => {
  it('calls markCallerDead on worker error event after handshake', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();
    const control = new SharedArrayBuffer(CONTROL_SAB_BYTES);

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'node-test-client',
      workerHeartbeatTimeoutMs: 0, // disable heartbeat
    });

    // Simulate hs-res passing through (the bridge monitors messages).
    worker.emit('message', {
      __sync: 'hs-res',
      control,
      data: new SharedArrayBuffer(4096),
      epoch: 7,
    });

    // Worker crashes.
    worker.emit('error', new Error('worker crashed'));

    // Verify SAB was marked DEAD.
    const view = new Int32Array(control);
    expect(Atomics.load(view, CTRL.CALLER_STATE)).toBe(CALLER_STATE.DEAD);

    // Verify client_dead was sent.
    const deadMsg = transport.sent.find(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        (m as {__sync?: string}).__sync === 'client_dead',
    ) as {epoch: number; clientId: string};
    expect(deadMsg).toBeDefined();
    expect(deadMsg.epoch).toBe(7);
    expect(deadMsg.clientId).toBe('node-test-client');

    bridge.dispose();
  });

  it('calls markCallerDead on worker exit event', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();
    const control = new SharedArrayBuffer(CONTROL_SAB_BYTES);

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'exit-client',
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('message', {
      __sync: 'hs-res',
      control,
      data: new SharedArrayBuffer(4096),
      epoch: 3,
    });

    worker.emit('exit', 1);

    const view = new Int32Array(control);
    expect(Atomics.load(view, CTRL.CALLER_STATE)).toBe(CALLER_STATE.DEAD);

    bridge.dispose();
  });

  it('death detection is idempotent — error then exit fires once', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();
    const control = new SharedArrayBuffer(CONTROL_SAB_BYTES);

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'dedup-client',
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('message', {
      __sync: 'hs-res',
      control,
      data: new SharedArrayBuffer(4096),
      epoch: 1,
    });

    worker.emit('error', new Error('crash'));
    worker.emit('exit', 1);

    const deadMsgs = transport.sent.filter(
      (m) =>
        typeof m === 'object' &&
        (m as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadMsgs).toHaveLength(1);

    bridge.dispose();
  });

  it('sends epoch-0 for pre-handshake death', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'pre-hs-client',
      workerHeartbeatTimeoutMs: 0,
    });

    // No handshake — worker dies immediately.
    worker.emit('error', new Error('instant crash'));

    const deadMsg = transport.sent.find(
      (m) => (m as {__sync?: string}).__sync === 'client_dead',
    ) as {epoch: number; clientId: string};
    expect(deadMsg).toBeDefined();
    expect(deadMsg.epoch).toBe(0);
    expect(deadMsg.clientId).toBe('pre-hs-client');

    bridge.dispose();
  });

  it('heartbeat timeout triggers death detection', () => {
    vi.useFakeTimers();
    try {
      const worker = createMockWorker();
      const transport = createStubTransport();
      const control = new SharedArrayBuffer(CONTROL_SAB_BYTES);

      const bridge = createNodeWorkerBridge({
        worker: worker as any,
        hostTransport: transport,
        clientId: 'heartbeat-client',
        workerHeartbeatTimeoutMs: 5000,
      });

      // Handshake to capture SAB.
      worker.emit('message', {
        __sync: 'hs-res',
        control,
        data: new SharedArrayBuffer(4096),
        epoch: 2,
      });

      // A regular message arms the heartbeat.
      worker.emit('message', {some: 'data'});

      // Advance past the timeout.
      vi.advanceTimersByTime(5001);

      const view = new Int32Array(control);
      expect(Atomics.load(view, CTRL.CALLER_STATE)).toBe(CALLER_STATE.DEAD);

      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose removes all listeners', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      workerHeartbeatTimeoutMs: 0,
    });

    expect(worker.listenerCount('message')).toBeGreaterThan(0);
    expect(worker.listenerCount('error')).toBeGreaterThan(0);
    expect(worker.listenerCount('exit')).toBeGreaterThan(0);

    bridge.dispose();

    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
  });

  it('dispose is idempotent', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      workerHeartbeatTimeoutMs: 0,
    });

    expect(() => {
      bridge.dispose();
      bridge.dispose();
    }).not.toThrow();
  });
});

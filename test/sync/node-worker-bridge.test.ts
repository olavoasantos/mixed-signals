/**
 * Tests for the Node `worker_threads` teardown detection helper.
 *
 * Uses a mock Worker (EventEmitter) to test death detection without
 * spawning real workers.
 */
import EventEmitter from 'node:events';
import {describe, expect, it, vi} from 'vitest';
import type {RawTransport} from '../../shared/protocol.ts';
import {createNodeWorkerBridge} from '../../sync/node-worker-bridge.ts';

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
  it('sends client_dead on worker error event', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'node-test-client',
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('error', new Error('worker crashed'));

    const deadMsg = transport.sent.find(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        (m as {__sync?: string}).__sync === 'client_dead',
    ) as {clientId: string};
    expect(deadMsg).toBeDefined();
    expect(deadMsg.clientId).toBe('node-test-client');

    bridge.dispose();
  });

  it('sends client_dead on worker exit event', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'exit-client',
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('exit', 1);

    const deadMsg = transport.sent.find(
      (m) => (m as {__sync?: string}).__sync === 'client_dead',
    ) as {clientId: string};
    expect(deadMsg).toBeDefined();
    expect(deadMsg.clientId).toBe('exit-client');

    bridge.dispose();
  });

  it('captures epoch from wrapped hs-res message', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'epoch-client',
      workerHeartbeatTimeoutMs: 0,
    });

    // Simulate wrapped hs-res message (multiplexed envelope).
    worker.emit('message', {
      kind: 'mixed-signals',
      data: {
        __sync: 'hs-res',
        control: new SharedArrayBuffer(256),
        data: new SharedArrayBuffer(4096),
        epoch: 42,
      },
    });

    worker.emit('error', new Error('crash'));

    const deadMsg = transport.sent.find(
      (m) => (m as {__sync?: string}).__sync === 'client_dead',
    ) as {epoch: number};
    expect(deadMsg.epoch).toBe(42);

    bridge.dispose();
  });

  it('death detection is idempotent — error then exit fires once', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'dedup-client',
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('error', new Error('crash'));
    worker.emit('exit', 1);

    const deadMsgs = transport.sent.filter(
      (m) => (m as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadMsgs).toHaveLength(1);

    bridge.dispose();
  });

  it('sends epoch-0 when no hs-res was captured', () => {
    const worker = createMockWorker();
    const transport = createStubTransport();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      hostTransport: transport,
      clientId: 'pre-hs',
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('error', new Error('crash'));

    const deadMsg = transport.sent.find(
      (m) => (m as {__sync?: string}).__sync === 'client_dead',
    ) as {epoch: number};
    expect(deadMsg.epoch).toBe(0);

    bridge.dispose();
  });

  it('heartbeat timeout triggers death detection', () => {
    vi.useFakeTimers();
    try {
      const worker = createMockWorker();
      const transport = createStubTransport();

      const bridge = createNodeWorkerBridge({
        worker: worker as any,
        hostTransport: transport,
        clientId: 'heartbeat-client',
        workerHeartbeatTimeoutMs: 5000,
      });

      // A regular message arms the heartbeat.
      worker.emit('message', {some: 'data'});

      vi.advanceTimersByTime(5001);

      const deadMsg = transport.sent.find(
        (m) => (m as {__sync?: string}).__sync === 'client_dead',
      );
      expect(deadMsg).toBeDefined();

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

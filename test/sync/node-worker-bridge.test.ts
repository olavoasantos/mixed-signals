/**
 * Tests for the Node `worker_threads` teardown detection helper.
 */
import EventEmitter from 'node:events';
import {describe, expect, it, vi} from 'vitest';
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

describe('createNodeWorkerBridge', () => {
  it('calls onDeath on worker error event', () => {
    const worker = createMockWorker();
    const onDeath = vi.fn();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      onDeath,
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('error', new Error('worker crashed'));
    expect(onDeath).toHaveBeenCalledOnce();

    bridge.dispose();
  });

  it('calls onDeath on worker exit event', () => {
    const worker = createMockWorker();
    const onDeath = vi.fn();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      onDeath,
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('exit', 1);
    expect(onDeath).toHaveBeenCalledOnce();

    bridge.dispose();
  });

  it('death detection is idempotent — error then exit fires once', () => {
    const worker = createMockWorker();
    const onDeath = vi.fn();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      onDeath,
      workerHeartbeatTimeoutMs: 0,
    });

    worker.emit('error', new Error('crash'));
    worker.emit('exit', 1);

    expect(onDeath).toHaveBeenCalledOnce();

    bridge.dispose();
  });

  it('heartbeat timeout triggers death detection', () => {
    vi.useFakeTimers();
    try {
      const worker = createMockWorker();
      const onDeath = vi.fn();

      const bridge = createNodeWorkerBridge({
        worker: worker as any,
        onDeath,
        workerHeartbeatTimeoutMs: 5000,
      });

      // A regular message arms the heartbeat.
      worker.emit('message', {some: 'data'});

      vi.advanceTimersByTime(5001);

      expect(onDeath).toHaveBeenCalledOnce();

      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows onDeath callback errors', () => {
    const worker = createMockWorker();
    const onDeath = vi.fn(() => {
      throw new Error('callback exploded');
    });

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      onDeath,
      workerHeartbeatTimeoutMs: 0,
    });

    expect(() => worker.emit('error', new Error('crash'))).not.toThrow();
    expect(onDeath).toHaveBeenCalledOnce();

    bridge.dispose();
  });

  it('dispose removes all listeners', () => {
    const worker = createMockWorker();
    const onDeath = vi.fn();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      onDeath,
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
    const onDeath = vi.fn();

    const bridge = createNodeWorkerBridge({
      worker: worker as any,
      onDeath,
      workerHeartbeatTimeoutMs: 0,
    });

    expect(() => {
      bridge.dispose();
      bridge.dispose();
    }).not.toThrow();
  });
});

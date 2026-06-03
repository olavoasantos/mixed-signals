/**
 * Unit tests for `createIframeBrokerBridge`. Mock-based; full
 * end-to-end cross-origin Playwright coverage lands in M008 / M009.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {SyncRPCIframeBridgeError} from '../../sync/errors.ts';
import {_createIframeBrokerBridgeInternal} from '../../sync/iframe-broker.ts';

type AnyHandler = (event: any) => void;

interface FakeWorker {
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
  addEventListener(type: string, cb: AnyHandler): void;
  removeEventListener(type: string, cb: AnyHandler): void;
  _listeners: AnyHandler[];
  _listenersByType: Map<string, AnyHandler[]>;
  _emit(partial: Partial<MessageEvent>): void;
  _emitEvent(type: string, event?: any): void;
  _sent: Array<{data: unknown; transfer: readonly unknown[]}>;
}

function makeFakeWorker(): FakeWorker {
  const listenersByType = new Map<string, AnyHandler[]>();
  const getListeners = (type: string) => {
    let arr = listenersByType.get(type);
    if (!arr) { arr = []; listenersByType.set(type, arr); }
    return arr;
  };
  const sent: Array<{data: unknown; transfer: readonly unknown[]}> = [];
  return {
    postMessage(data, transfer = []) {
      sent.push({data, transfer});
    },
    addEventListener(type: string, cb: AnyHandler) {
      getListeners(type).push(cb);
    },
    removeEventListener(type: string, cb: AnyHandler) {
      const arr = listenersByType.get(type);
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    },
    _listeners: getListeners('message'),
    _listenersByType: listenersByType,
    _emit(partial) {
      const event = partial as MessageEvent;
      for (const h of getListeners('message').slice()) h(event);
    },
    _emitEvent(type: string, event?: any) {
      for (const h of getListeners(type).slice()) h(event ?? {});
    },
    _sent: sent,
  };
}

interface FakeHostTransport extends RawTransport {
  /** Outbound payloads observed on the host transport. */
  sent: Array<{data: unknown; ctx?: TransportContext}>;
  /** Synthetically deliver an inbound message. */
  inbound(data: unknown, ctx?: TransportContext): void;
}

function makeFakeHostTransport(): FakeHostTransport {
  type Cb = (data: unknown, ctx?: TransportContext) => void | Promise<void>;
  const listeners: Cb[] = [];
  const sent: Array<{data: unknown; ctx?: TransportContext}> = [];
  return {
    mode: 'raw',
    send(data, ctx) {
      sent.push({data, ctx});
    },
    onMessage(cb) {
      listeners.push(cb);
    },
    sent,
    inbound(data, ctx) {
      for (const cb of listeners.slice()) cb(data, ctx);
    },
  };
}

describe('createIframeBrokerBridge — construction', () => {
  it('throws SyncRPCIframeBridgeError when crossOriginIsolated is false', () => {
    expect(() =>
      _createIframeBrokerBridgeInternal({
        worker: makeFakeWorker(),
        hostTransport: makeFakeHostTransport(),
        _crossOriginIsolated: false,
      }),
    ).toThrow(SyncRPCIframeBridgeError);
  });

  it('returns an IframeBrokerBridge with dispose, server, client when COI', () => {
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker: makeFakeWorker(),
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    expect(typeof bridge.dispose).toBe('function');
    expect(bridge.server).toBe(host); // server is the user-supplied transport
    expect(bridge.client.mode).toBe('raw');

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — handshake (sync)', () => {
  it('processes hs-req from the worker locally and replies via worker.postMessage', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    // Worker initiates handshake.
    worker._emit({data: {__sync: 'hs-req'}});

    // hs-res should have been posted to the worker (NOT to the parent).
    expect(worker._sent.length).toBe(1);
    const handshakeReply = worker._sent[0]?.data as {
      __sync?: string;
      control?: SharedArrayBuffer;
      data?: SharedArrayBuffer;
    };
    expect(handshakeReply.__sync).toBe('hs-res');
    expect(handshakeReply.control).toBeInstanceOf(SharedArrayBuffer);
    expect(handshakeReply.data).toBeInstanceOf(SharedArrayBuffer);

    // The parent never sees the SAB transfer.
    expect(host.sent).toEqual([]);

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — async pass-through', () => {
  it('forwards normal WireMessages from the worker to the parent', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    const call: WireMessage = {
      type: 'call',
      id: 1,
      method: 'foo',
      params: [],
    };
    worker._emit({data: call});

    expect(host.sent.length).toBe(1);
    expect(host.sent[0]?.data).toEqual(call);

    bridge.dispose();
  });

  it('forwards normal WireMessages from the parent to the worker', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    const result: WireMessage = {
      type: 'result',
      id: 1,
      value: 'pong',
    };
    host.inbound(result);

    expect(worker._sent.length).toBe(1);
    expect(worker._sent[0]?.data).toEqual(result);

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires client_dead upstream after timeoutMs of worker silence following first message', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
      workerHeartbeatTimeoutMs: 1000,
    });

    worker._emit({data: {first: true}});

    vi.advanceTimersByTime(999);
    let deadSends = host.sent.filter(
      (s) =>
        s.data !== null &&
        typeof s.data === 'object' &&
        (s.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadSends).toHaveLength(0);

    vi.advanceTimersByTime(2);
    deadSends = host.sent.filter(
      (s) =>
        s.data !== null &&
        typeof s.data === 'object' &&
        (s.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadSends).toHaveLength(1);

    bridge.dispose();
  });

  it('does not arm the heartbeat before any worker message arrives', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
      workerHeartbeatTimeoutMs: 1000,
    });

    vi.advanceTimersByTime(5000);
    const deadSends = host.sent.filter(
      (s) =>
        s.data !== null &&
        typeof s.data === 'object' &&
        (s.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadSends).toHaveLength(0);

    bridge.dispose();
  });
});

describe('createIframeBrokerBridge — dispose', () => {
  it('detaches the worker message listener', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    expect(worker._listeners.length).toBe(1);
    bridge.dispose();
    expect(worker._listeners.length).toBe(0);
  });

  it('dispose() is idempotent', () => {
    const bridge = _createIframeBrokerBridgeInternal({
      worker: makeFakeWorker(),
      hostTransport: makeFakeHostTransport(),
      _crossOriginIsolated: true,
    });
    expect(() => {
      bridge.dispose();
      bridge.dispose();
      bridge.dispose();
    }).not.toThrow();
  });

  it('post-dispose worker messages are not forwarded', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    worker._emit({data: {type: 'notification', method: '@R', params: []}});
    expect(host.sent.length).toBe(1);

    bridge.dispose();
    worker._emit({data: {type: 'notification', method: '@R', params: []}});
    expect(host.sent.length).toBe(1);
  });
});

describe('createIframeBrokerBridge — teardown detection', () => {
  function createBrokerWithHandshake(opts?: {clientId?: string}) {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      clientId: opts?.clientId ?? 'broker-test-client',
      _crossOriginIsolated: true,
    });

    // Trigger the handshake: worker sends hs-req, enableSyncServer
    // responds with hs-res (which the broker intercepts to capture
    // the control SAB + epoch).
    worker._emit({data: {__sync: 'hs-req'}});

    // Find the hs-res in worker._sent (it was posted to the worker).
    const hsRes = worker._sent.find(
      (msg) =>
        typeof msg.data === 'object' &&
        msg.data !== null &&
        (msg.data as {__sync?: string}).__sync === 'hs-res',
    );
    const control = (hsRes?.data as {control: SharedArrayBuffer}).control;
    const epoch = (hsRes?.data as {epoch: number}).epoch;

    return {bridge, worker, host, control, epoch};
  }

  it('sends client_dead upstream on worker error event', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      clientId: 'broker-test-client',
      _crossOriginIsolated: true,
    });

    // Trigger handshake.
    worker._emit({data: {__sync: 'hs-req'}});

    // Fire error on the worker.
    worker._emitEvent('error', {type: 'error'});

    // The death notification should have been sent upstream via hostTransport.
    const deadMsg = host.sent.find(
      (msg) =>
        typeof msg.data === 'object' &&
        msg.data !== null &&
        (msg.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadMsg).toBeDefined();
    expect(deadMsg!.data).toMatchObject({
      __sync: 'client_dead',
      clientId: 'broker-test-client',
    });

    bridge.dispose();
  });

  it('sends client_dead on messageerror event', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      clientId: 'broker-msg-err',
      _crossOriginIsolated: true,
    });

    worker._emit({data: {__sync: 'hs-req'}});
    worker._emitEvent('messageerror');

    const deadMsg = host.sent.find(
      (msg) =>
        typeof msg.data === 'object' &&
        (msg.data as {__sync?: string}).__sync === 'client_dead',
    );
    expect(deadMsg).toBeDefined();

    bridge.dispose();
  });

  it('emitDeath is idempotent — second error is a no-op', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      clientId: 'broker-dedup',
      _crossOriginIsolated: true,
    });

    worker._emit({data: {__sync: 'hs-req'}});

    worker._emitEvent('error');
    const deadCountFirst = host.sent.filter(
      (msg) => (msg.data as {__sync?: string}).__sync === 'client_dead',
    ).length;

    worker._emitEvent('error');
    const deadCountSecond = host.sent.filter(
      (msg) => (msg.data as {__sync?: string}).__sync === 'client_dead',
    ).length;

    expect(deadCountSecond).toBe(deadCountFirst);

    bridge.dispose();
  });

  it('dispose removes error and messageerror listeners', () => {
    const worker = makeFakeWorker();
    const host = makeFakeHostTransport();
    const bridge = _createIframeBrokerBridgeInternal({
      worker,
      hostTransport: host,
      _crossOriginIsolated: true,
    });

    expect((worker._listenersByType.get('error')?.length ?? 0)).toBeGreaterThan(0);

    bridge.dispose();

    expect(worker._listenersByType.get('error')?.length ?? 0).toBe(0);
    expect(worker._listenersByType.get('messageerror')?.length ?? 0).toBe(0);
  });
});

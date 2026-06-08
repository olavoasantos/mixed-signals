/**
 * Shared test doubles for sync tests.
 *
 * Consolidates the fake Window/Worker factories, stub transports, and
 * paired transports that were previously duplicated across iframe-relay,
 * iframe-broker, iframe-bridge-errors, enable-client, server-teardown,
 * and lifecycle test files.
 */
import {vi} from 'vitest';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';

// ─── Types ──────────────────────────────────────────────────────────────

export type AnyHandler = (event: any) => void;

export type WindowPostMessageFn = (
  data: unknown,
  targetOrigin: string,
  transfer?: readonly unknown[],
) => void;

export type WorkerPostMessageFn = (
  data: unknown,
  transfer?: readonly unknown[],
) => void;

export interface FakeEventTarget {
  addEventListener(type: string, cb: AnyHandler): void;
  removeEventListener(type: string, cb: AnyHandler): void;
  _listeners: AnyHandler[];
  _listenersByType: Map<string, AnyHandler[]>;
  _emit(partial: Partial<MessageEvent>): void;
  _emitEvent(type: string, event?: any): void;
}

export interface FakeWindow extends FakeEventTarget {
  postMessage: ReturnType<typeof vi.fn<WindowPostMessageFn>>;
}

export interface FakeWorker extends FakeEventTarget {
  postMessage: ReturnType<typeof vi.fn<WorkerPostMessageFn>>;
}

export interface FakeWorkerWithSent extends FakeEventTarget {
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
  _sent: Array<{data: unknown; transfer: readonly unknown[]}>;
}

export interface FakeHostTransport extends RawTransport {
  sent: Array<{data: unknown; ctx?: TransportContext}>;
  inbound(data: unknown, ctx?: TransportContext): void;
}

export interface StubTransport {
  transport: RawTransport;
  sent: unknown[];
  receive(data: unknown): void;
}

// ─── Internal helper ────────────────────────────────────────────────────

function makeListenerMap() {
  const listenersByType = new Map<string, AnyHandler[]>();
  const getListeners = (type: string) => {
    let arr = listenersByType.get(type);
    if (!arr) {
      arr = [];
      listenersByType.set(type, arr);
    }
    return arr;
  };
  return {listenersByType, getListeners};
}

function eventTargetMixin(getListeners: (type: string) => AnyHandler[], listenersByType: Map<string, AnyHandler[]>) {
  return {
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
    _emit(partial: Partial<MessageEvent>) {
      const event = partial as MessageEvent;
      for (const h of getListeners('message').slice()) h(event);
    },
    _emitEvent(type: string, event?: any) {
      for (const h of getListeners(type).slice()) h(event ?? {});
    },
  };
}

// ─── Fake Window ────────────────────────────────────────────────────────

/**
 * A fake `Window`-shaped object with `postMessage`, `addEventListener`,
 * `removeEventListener`, and test introspection helpers.
 */
export function makeFakeWindow(): FakeWindow {
  const {listenersByType, getListeners} = makeListenerMap();
  return {
    postMessage: vi.fn<WindowPostMessageFn>(),
    ...eventTargetMixin(getListeners, listenersByType),
  };
}

// ─── Fake Worker (vi.fn postMessage) ────────────────────────────────────

/**
 * A fake `Worker`-shaped object with `vi.fn()` postMessage, suitable
 * for spy assertions. Use `makeFakeWorkerWithSent` when you need to
 * inspect outbound payloads structurally instead of via spy.
 */
export function makeFakeWorker(): FakeWorker {
  const {listenersByType, getListeners} = makeListenerMap();
  return {
    postMessage: vi.fn<WorkerPostMessageFn>(),
    ...eventTargetMixin(getListeners, listenersByType),
  };
}

// ─── Fake Worker (outbox tracking) ──────────────────────────────────────

/**
 * A fake `Worker`-shaped object that records outbound messages in `_sent`
 * instead of using `vi.fn`. Useful when tests need to inspect the
 * transfer list alongside the data.
 */
export function makeFakeWorkerWithSent(): FakeWorkerWithSent {
  const {listenersByType, getListeners} = makeListenerMap();
  const sent: Array<{data: unknown; transfer: readonly unknown[]}> = [];
  return {
    postMessage(data: unknown, transfer: readonly unknown[] = []) {
      sent.push({data, transfer});
    },
    ...eventTargetMixin(getListeners, listenersByType),
    _sent: sent,
  };
}

// ─── Fake Host Transport ────────────────────────────────────────────────

/**
 * A fake `RawTransport` with `sent` tracking and `inbound()` to
 * simulate incoming messages. Used by iframe-broker tests.
 */
export function makeFakeHostTransport(): FakeHostTransport {
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

// ─── Stub Transport ─────────────────────────────────────────────────────

/**
 * A minimal stub transport that records outbound messages and exposes
 * `receive()` to simulate inbound messages. Used by server-teardown
 * and lifecycle tests.
 */
export function createStubTransport(): StubTransport {
  type Listener = (data: unknown, ctx?: TransportContext) => void | Promise<void>;
  const sent: unknown[] = [];
  let listener: Listener | undefined;
  const transport: RawTransport = {
    mode: 'raw',
    send(data) {
      sent.push(data);
    },
    onMessage(cb) {
      listener = cb;
    },
  };
  return {
    transport,
    sent,
    receive(data: unknown) {
      listener?.(data);
    },
  };
}

// ─── Paired Transports ──────────────────────────────────────────────────

/**
 * Two in-memory transports wired back-to-back. Client's `send` delivers
 * to host's `onMessage` subscribers and vice versa. Used by enable-client
 * and iframe-bridge-errors tests.
 */
export function pairedTransports(): {
  clientSide: RawTransport;
  hostSide: RawTransport;
  hostReceived: unknown[];
} {
  type Handler = (data: unknown, ctx?: TransportContext) => void | Promise<void>;
  const clientHandlers: Handler[] = [];
  const hostHandlers: Handler[] = [];
  const hostReceived: unknown[] = [];

  const clientSide: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      hostReceived.push(data);
      for (const h of hostHandlers) h(data, ctx);
    },
    onMessage(cb) {
      clientHandlers.push(cb);
    },
  };

  const hostSide: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      for (const h of clientHandlers) h(data, ctx);
    },
    onMessage(cb) {
      hostHandlers.push(cb);
    },
  };

  return {clientSide, hostSide, hostReceived};
}

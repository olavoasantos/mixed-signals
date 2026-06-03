/**
 * Focused tests for `SyncRPCIframeBridgeError` throw sites.
 *
 * These exercise the detailed error properties (`.name`, `instanceof`
 * hierarchy, diagnostic substring, doc-pointer) for every
 * `SyncRPCIframeBridgeError` throw site that isn't already fully
 * asserted in the existing test files.
 *
 * Existing coverage (NOT duplicated here):
 *   - `iframe-relay.test.ts` — asserts `toThrow(SyncRPCIframeBridgeError)`
 *     for opaque origin and parentWindow===localWindow, BUT only the
 *     instanceof check; no `.name`, parent class, message, or doc-pointer.
 *   - `iframe-broker.test.ts` — asserts `toThrow(SyncRPCIframeBridgeError)`
 *     for COI=false, same gap as relay.
 *   - `enable-client.test.ts` — asserts `toBeInstanceOf(SyncRPCIframeBridgeError)`
 *     for ArrayBuffer hs-res, same gap.
 *
 * This file fills those gaps with comprehensive property tests and adds
 * NEW tests for throw sites not covered elsewhere:
 *   - Relay: missing localWindow (no addEventListener)
 *   - Relay: missing parentWindow (no postMessage)
 *   - Client handshake: null/undefined SAB fields
 *   - Client handshake: both fields missing
 *   - Sidecar missing for transferable values
 */
import {describe, expect, it, vi} from 'vitest';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncClient} from '../../sync/client.ts';
import {
  SyncRPCError,
  SyncRPCIframeBridgeError,
} from '../../sync/errors.ts';
import {_createIframeBrokerBridgeInternal} from '../../sync/iframe-broker.ts';
import {_createIframeRelayBridgeInternal} from '../../sync/iframe-relay.ts';
import {allocateLane} from '../../sync/lane.ts';

// ── Stubs ────────────────────────────────────────────────────────────────

type AnyHandler = (event: any) => void;

type WindowPostMessageFn = (
  data: unknown,
  targetOrigin: string,
  transfer?: readonly unknown[],
) => void;

function makeFakeWindow() {
  const listenersByType = new Map<string, AnyHandler[]>();
  const getListeners = (type: string) => {
    let arr = listenersByType.get(type);
    if (!arr) {
      arr = [];
      listenersByType.set(type, arr);
    }
    return arr;
  };
  return {
    postMessage: vi.fn<WindowPostMessageFn>(),
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
  };
}

function makeFakeWorker() {
  const listenersByType = new Map<string, AnyHandler[]>();
  const getListeners = (type: string) => {
    let arr = listenersByType.get(type);
    if (!arr) {
      arr = [];
      listenersByType.set(type, arr);
    }
    return arr;
  };
  return {
    postMessage: vi.fn(),
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
    _emit(partial: Partial<MessageEvent>) {
      const event = partial as MessageEvent;
      for (const h of getListeners('message').slice()) h(event);
    },
  };
}

function makeFakeHostTransport(): RawTransport & {
  sent: Array<{data: unknown; ctx?: TransportContext}>;
  inbound(data: unknown, ctx?: TransportContext): void;
} {
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

/**
 * Paired in-memory raw transport for handshake tests.
 */
function pairedTransports() {
  type Handler = (
    data: unknown,
    ctx?: TransportContext,
  ) => void | Promise<void>;
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

/**
 * Helper: catch a synchronous throw and return the error for assertion.
 */
function catchSync(fn: () => unknown): unknown {
  try {
    fn();
    throw new Error('Expected function to throw');
  } catch (e) {
    return e;
  }
}

/**
 * Standard assertions for any SyncRPCIframeBridgeError.
 */
function assertBridgeError(
  err: unknown,
  opts: {messageContains: string | string[]},
) {
  expect(err).toBeInstanceOf(SyncRPCIframeBridgeError);
  expect(err).toBeInstanceOf(SyncRPCError);
  expect(err).toBeInstanceOf(Error);
  expect((err as SyncRPCIframeBridgeError).name).toBe(
    'SyncRPCIframeBridgeError',
  );
  expect((err as SyncRPCIframeBridgeError).message).toContain(
    'docs/sync-mode.md#iframe-bridge-errors',
  );
  const substrings = Array.isArray(opts.messageContains)
    ? opts.messageContains
    : [opts.messageContains];
  for (const sub of substrings) {
    expect((err as Error).message).toContain(sub);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Iframe Relay Bridge — detailed error property tests
// ═══════════════════════════════════════════════════════════════════════════

describe('IframeRelayBridge — error properties', () => {
  it('opaque origin: full error hierarchy, name, message diagnostics, doc pointer', () => {
    const err = catchSync(() =>
      _createIframeRelayBridgeInternal({
        worker: makeFakeWorker(),
        parentOrigin: 'null',
        _localWindow: makeFakeWindow(),
        _parentWindow: makeFakeWindow(),
      }),
    );
    assertBridgeError(err, {
      messageContains: ['opaque', 'createIframeRelayBridge'],
    });
  });

  it('parentWindow === localWindow: full error hierarchy, name, diagnostics, doc pointer', () => {
    const win = makeFakeWindow();
    const err = catchSync(() =>
      _createIframeRelayBridgeInternal({
        worker: makeFakeWorker(),
        parentOrigin: 'https://example.test',
        _localWindow: win,
        _parentWindow: win,
      }),
    );
    assertBridgeError(err, {
      messageContains: ['window.parent === window', 'createIframeRelayBridge'],
    });
  });

  it('missing localWindow (no addEventListener): throws with diagnostic', () => {
    // Pass _localWindow as undefined-like object without addEventListener
    // to hit the "no usable window.addEventListener" branch.
    const err = catchSync(() =>
      _createIframeRelayBridgeInternal({
        worker: makeFakeWorker(),
        parentOrigin: 'https://example.test',
        _localWindow: {
          postMessage: vi.fn(),
          addEventListener: 'not-a-function' as any,
          removeEventListener: vi.fn(),
        } as any,
        _parentWindow: makeFakeWindow(),
      }),
    );
    assertBridgeError(err, {
      messageContains: ['window.addEventListener', 'createIframeRelayBridge'],
    });
  });

  it('missing parentWindow (no postMessage): throws with diagnostic', () => {
    const err = catchSync(() =>
      _createIframeRelayBridgeInternal({
        worker: makeFakeWorker(),
        parentOrigin: 'https://example.test',
        _localWindow: makeFakeWindow(),
        _parentWindow: {
          postMessage: 'not-a-function' as any,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        } as any,
      }),
    );
    assertBridgeError(err, {
      messageContains: [
        'window.parent.postMessage',
        'createIframeRelayBridge',
      ],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Iframe Broker Bridge — detailed error property tests
// ═══════════════════════════════════════════════════════════════════════════

describe('IframeBrokerBridge — error properties', () => {
  it('COI=false: full error hierarchy, name, diagnostics, doc pointer', () => {
    const err = catchSync(() =>
      _createIframeBrokerBridgeInternal({
        worker: makeFakeWorker(),
        hostTransport: makeFakeHostTransport(),
        _crossOriginIsolated: false,
      }),
    );
    assertBridgeError(err, {
      messageContains: [
        'crossOriginIsolated',
        'createIframeBrokerBridge',
      ],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. enableSyncClient handshake — malformed hs-res variants
// ═══════════════════════════════════════════════════════════════════════════

describe('enableSyncClient — malformed hs-res error properties', () => {
  it('ArrayBuffer instead of SAB: full error hierarchy, name, "ArrayBuffer" in message, doc pointer', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    hostSide.send({
      __sync: 'hs-res',
      control: new ArrayBuffer(256),
      data: new ArrayBuffer(64 * 1024),
    });

    try {
      await pending;
      expect.fail('Expected rejection');
    } catch (err) {
      assertBridgeError(err, {
        messageContains: ['ArrayBuffer', 'enableSyncClient'],
      });
    }
  });

  it('control is ArrayBuffer but data is SAB: diagnoses control side specifically', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    hostSide.send({
      __sync: 'hs-res',
      control: new ArrayBuffer(256),
      data: new SharedArrayBuffer(64 * 1024),
    });

    try {
      await pending;
      expect.fail('Expected rejection');
    } catch (err) {
      assertBridgeError(err, {
        messageContains: ['ArrayBuffer', 'control=ArrayBuffer'],
      });
    }
  });

  it('data is ArrayBuffer but control is SAB: diagnoses data side specifically', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    hostSide.send({
      __sync: 'hs-res',
      control: new SharedArrayBuffer(256),
      data: new ArrayBuffer(64 * 1024),
    });

    try {
      await pending;
      expect.fail('Expected rejection');
    } catch (err) {
      assertBridgeError(err, {
        messageContains: ['ArrayBuffer', 'data=ArrayBuffer'],
      });
    }
  });

  it('control=null and data=null: "malformed SAB" message with doc pointer', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    hostSide.send({
      __sync: 'hs-res',
      control: null,
      data: null,
    });

    try {
      await pending;
      expect.fail('Expected rejection');
    } catch (err) {
      assertBridgeError(err, {
        messageContains: ['malformed SAB', 'enableSyncClient'],
      });
    }
  });

  it('control=undefined, data=undefined: "malformed SAB" message', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    hostSide.send({
      __sync: 'hs-res',
      control: undefined,
      data: undefined,
    });

    try {
      await pending;
      expect.fail('Expected rejection');
    } catch (err) {
      assertBridgeError(err, {
        messageContains: ['malformed SAB', 'enableSyncClient'],
      });
    }
  });

  it('both fields entirely missing: "malformed SAB" message', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    // Send hs-res without control or data fields at all.
    hostSide.send({__sync: 'hs-res'});

    try {
      await pending;
      expect.fail('Expected rejection');
    } catch (err) {
      assertBridgeError(err, {
        messageContains: ['malformed SAB', 'enableSyncClient'],
      });
    }
  });

  it('control is a string, data is a number: "malformed SAB" with type info', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    hostSide.send({
      __sync: 'hs-res',
      control: 'not-a-sab',
      data: 42,
    });

    try {
      await pending;
      expect.fail('Expected rejection');
    } catch (err) {
      assertBridgeError(err, {
        messageContains: ['malformed SAB', 'control=string', 'data=number'],
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Sidecar missing for transferable values
// ═══════════════════════════════════════════════════════════════════════════

describe('enableSyncClient — sidecar missing for transferable wait()', () => {
  it('throws SyncRPCIframeBridgeError when wait() batch contains Transferable but no sidecar', async () => {
    const {clientSide, hostSide} = pairedTransports();
    const pending = enableSyncClient(clientSide);

    // Complete handshake with valid SABs but NO sidecar port.
    const {control, data} = allocateLane();
    hostSide.send({__sync: 'hs-res', control, data});

    const transport = await pending;

    // Stub send so the doorbell doesn't try to go anywhere.
    const sendSpy = vi
      .spyOn(transport, 'send')
      .mockImplementation(() => {});

    try {
      // Call wait with a call whose params contain a Transferable
      // (ArrayBuffer). This triggers the sidecar check before
      // any Atomics.wait call.
      const err = catchSync(() =>
        transport.wait!(
          [
            {
              type: 'call',
              id: 1,
              method: 'upload',
              params: [new ArrayBuffer(16)],
            },
          ],
          {timeoutMs: 100},
        ),
      );
      assertBridgeError(err, {
        messageContains: ['sidecar', 'Transferable'],
      });
      // Also verify the doc pointer is present (different section).
      expect((err as Error).message).toContain(
        'docs/sync-mode.md#iframe-bridge-errors',
      );
    } finally {
      sendSpy.mockRestore();
    }
  });
});

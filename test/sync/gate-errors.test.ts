/**
 * Unit tests for the three gate-error classes that fire at
 * `RPCClient.wait()` entry time — before any wire I/O or promise
 * validation:
 *
 *   1. SyncRPCNoTransportWaitError  — transport lacks `wait?`
 *   2. SyncRPCNotCrossOriginIsolatedError — browser worker without COI
 *   3. SyncRPCUnsupportedContextError — main thread / ServiceWorker / no SAB
 *
 * All tests run in Node's Vitest environment (no Playwright). Global
 * stubs simulate browser contexts so `detectUnsupportedContext()` hits
 * the relevant branches.
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RPCClient} from '../../client/rpc.ts';
import {createRawMemoryTransportPair} from '../../server/memory-transport.ts';
import {RPC} from '../../server/rpc.ts';
import type {WireMessage} from '../../shared/protocol.ts';
import {
  SyncRPCError,
  SyncRPCNoTransportWaitError,
  SyncRPCNotCrossOriginIsolatedError,
  SyncRPCUnsupportedContextError,
} from '../../sync/errors.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal server + client pair. The client transport is returned without
 * a `wait` method, so callers can spread-extend it as needed.
 */
function setup() {
  const [serverT, clientT] = createRawMemoryTransportPair();
  const rpc = new RPC({noop() { return 'ok'; }});
  rpc.addClient(serverT);
  return {rpc, clientT};
}

/**
 * Wrap the base transport with a no-op `wait` stub so the
 * no-transport-wait gate passes, letting later gates fire.
 */
function withWait(base: ReturnType<typeof createRawMemoryTransportPair>[1]) {
  return {
    ...base,
    wait(): WireMessage[] {
      throw new Error('should not be reached');
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup: restore every global stub after each test.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. SyncRPCNoTransportWaitError
// ---------------------------------------------------------------------------

describe('SyncRPCNoTransportWaitError', () => {
  it('throws when the transport has no wait method', () => {
    const {rpc, clientT} = setup();
    // clientT is a base raw transport — no `wait`.
    const client = new RPCClient(clientT);

    try {
      // Pass a dummy array: the gate fires before promise validation.
      expect(() => client.wait([{} as any])).toThrow(
        SyncRPCNoTransportWaitError,
      );
    } finally {
      rpc.close();
    }
  });

  it('error is instanceof SyncRPCNoTransportWaitError and SyncRPCError', () => {
    const {rpc, clientT} = setup();
    const client = new RPCClient(clientT);

    try {
      client.wait([{} as any]);
    } catch (error) {
      expect(error).toBeInstanceOf(SyncRPCNoTransportWaitError);
      expect(error).toBeInstanceOf(SyncRPCError);
      expect((error as Error).name).toBe('SyncRPCNoTransportWaitError');
      expect((error as Error).message).toContain(
        'docs/sync-mode.md#no-transport-wait',
      );
    } finally {
      rpc.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SyncRPCNotCrossOriginIsolatedError — browser worker without COI
// ---------------------------------------------------------------------------

describe('SyncRPCNotCrossOriginIsolatedError', () => {
  it('throws in a simulated non-COI browser worker context', () => {
    // Make the environment look like a browser Worker that is NOT
    // cross-origin isolated.
    vi.stubGlobal('WorkerGlobalScope', {});
    vi.stubGlobal('crossOriginIsolated', false);

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      expect(() => client.wait([{} as any])).toThrow(
        SyncRPCNotCrossOriginIsolatedError,
      );
    } finally {
      rpc.close();
    }
  });

  it('error is instanceof SyncRPCNotCrossOriginIsolatedError and SyncRPCError', () => {
    vi.stubGlobal('WorkerGlobalScope', {});
    vi.stubGlobal('crossOriginIsolated', false);

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      client.wait([{} as any]);
    } catch (error) {
      expect(error).toBeInstanceOf(SyncRPCNotCrossOriginIsolatedError);
      expect(error).toBeInstanceOf(SyncRPCError);
      expect((error as Error).name).toBe(
        'SyncRPCNotCrossOriginIsolatedError',
      );
      expect((error as Error).message).toContain(
        'docs/sync-mode.md#cross-origin-isolation',
      );
    } finally {
      rpc.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SyncRPCUnsupportedContextError — main thread
// ---------------------------------------------------------------------------

describe('SyncRPCUnsupportedContextError — browser main thread', () => {
  it('throws when globalThis.window === globalThis', () => {
    vi.stubGlobal('window', globalThis);

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      expect(() => client.wait([{} as any])).toThrow(
        SyncRPCUnsupportedContextError,
      );
    } finally {
      rpc.close();
    }
  });

  it('error is instanceof SyncRPCUnsupportedContextError and SyncRPCError, message mentions main thread', () => {
    vi.stubGlobal('window', globalThis);

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      client.wait([{} as any]);
    } catch (error) {
      expect(error).toBeInstanceOf(SyncRPCUnsupportedContextError);
      expect(error).toBeInstanceOf(SyncRPCError);
      expect((error as Error).name).toBe('SyncRPCUnsupportedContextError');
      expect((error as Error).message).toContain('main thread');
      expect((error as Error).message).toContain(
        'docs/sync-mode.md#worker-context',
      );
    } finally {
      rpc.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. SyncRPCUnsupportedContextError — ServiceWorker
// ---------------------------------------------------------------------------

describe('SyncRPCUnsupportedContextError — ServiceWorker', () => {
  it('throws when globalThis.ServiceWorkerGlobalScope is defined', () => {
    vi.stubGlobal('ServiceWorkerGlobalScope', {});

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      expect(() => client.wait([{} as any])).toThrow(
        SyncRPCUnsupportedContextError,
      );
    } finally {
      rpc.close();
    }
  });

  it('error is instanceof SyncRPCUnsupportedContextError and SyncRPCError, message mentions ServiceWorker', () => {
    vi.stubGlobal('ServiceWorkerGlobalScope', {});

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      client.wait([{} as any]);
    } catch (error) {
      expect(error).toBeInstanceOf(SyncRPCUnsupportedContextError);
      expect(error).toBeInstanceOf(SyncRPCError);
      expect((error as Error).name).toBe('SyncRPCUnsupportedContextError');
      expect((error as Error).message).toContain('ServiceWorker');
      expect((error as Error).message).toContain(
        'docs/sync-mode.md#worker-context',
      );
    } finally {
      rpc.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. SyncRPCUnsupportedContextError — no SharedArrayBuffer
// ---------------------------------------------------------------------------

describe('SyncRPCUnsupportedContextError — no SharedArrayBuffer', () => {
  it('throws when SharedArrayBuffer is undefined', () => {
    vi.stubGlobal('SharedArrayBuffer', undefined);

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      expect(() => client.wait([{} as any])).toThrow(
        SyncRPCUnsupportedContextError,
      );
    } finally {
      rpc.close();
    }
  });

  it('error is instanceof SyncRPCUnsupportedContextError and SyncRPCError, message mentions SharedArrayBuffer', () => {
    vi.stubGlobal('SharedArrayBuffer', undefined);

    const {rpc, clientT} = setup();
    const client = new RPCClient(withWait(clientT));

    try {
      client.wait([{} as any]);
    } catch (error) {
      expect(error).toBeInstanceOf(SyncRPCUnsupportedContextError);
      expect(error).toBeInstanceOf(SyncRPCError);
      expect((error as Error).name).toBe('SyncRPCUnsupportedContextError');
      expect((error as Error).message).toContain('SharedArrayBuffer');
      expect((error as Error).message).toContain(
        'docs/sync-mode.md#worker-context',
      );
    } finally {
      rpc.close();
    }
  });
});

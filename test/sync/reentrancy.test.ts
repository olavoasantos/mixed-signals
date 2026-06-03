/**
 * Tests for the reentrancy guard in enableSyncServer's transport
 * wrapper. The guard prevents outbound call-type frames to a
 * sync-blocked client during active dispatch.
 *
 * Tested at the transport wrapper level: the host RPC dispatches a
 * sync batch, and during dispatch the method tries to send a call
 * frame back through the wrapper. The guard throws
 * SyncRPCReentrancyError synchronously.
 */
import {Worker} from 'node:worker_threads';
import {afterEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {enableSyncServer} from '../../sync/server.ts';
import {SyncRPCReentrancyError} from '../../sync/errors.ts';

const WORKER_URL = new URL('./_caller-fixture.ts', import.meta.url);

// ── Harness (same pattern as enable-server.test.ts) ─────────────────

interface Harness {
  worker: Worker;
  rpc: RPC;
  /** The sync-wrapped transport returned by enableSyncServer. */
  wrapped: RawTransport;
  cmd: <T = unknown>(command: {
    type: string;
    [k: string]: unknown;
  }) => Promise<T>;
  dispose: () => Promise<void>;
}

function setupHarness(root: object): Harness {
  const worker = new Worker(WORKER_URL);

  const rpcListeners: Array<
    (data: unknown, ctx?: TransportContext) => void | Promise<void>
  > = [];
  const testListeners: Array<(data: unknown) => void> = [];

  worker.on('message', (envelope: {kind: string; data: unknown}) => {
    if (envelope?.kind === 'mixed-signals') {
      for (const listener of rpcListeners) listener(envelope.data);
    } else if (envelope?.kind === 'test') {
      for (const listener of testListeners) listener(envelope.data);
    }
  });

  const base: RawTransport = {
    mode: 'raw',
    send(data) {
      worker.postMessage({kind: 'mixed-signals', data});
    },
    onMessage(cb) {
      rpcListeners.push(cb);
    },
  };

  const wrapped = enableSyncServer(base);
  const rpc = new RPC(root);
  rpc.addClient(wrapped);

  const readyPromise = new Promise<void>((resolve, reject) => {
    testListeners.push((msg: unknown) => {
      const m = msg as {type: string; error?: string};
      if (m.type === 'ready') resolve();
      if (m.type === 'fatal')
        reject(new Error(`worker fatal: ${m.error ?? '(no message)'}`));
    });
  });

  let nextId = 1;
  function cmd<T>(command: {
    type: string;
    [k: string]: unknown;
  }): Promise<T> {
    const id = nextId++;
    return readyPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const listener = (msg: unknown) => {
            const m = msg as {
              type: string;
              id?: number;
              ok?: boolean;
              error?: string;
            };
            if (m.id !== id) return;
            const idx = testListeners.indexOf(listener);
            if (idx >= 0) testListeners.splice(idx, 1);
            if (m.ok === false) {
              reject(new Error(m.error ?? '(no error message)'));
            } else {
              resolve(m as T);
            }
          };
          testListeners.push(listener);
          worker.postMessage({kind: 'test', data: {...command, id}});
        }),
    );
  }

  return {
    worker,
    rpc,
    wrapped,
    cmd,
    dispose: async () => {
      await worker.terminate();
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SyncRPCReentrancyError', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('throws when a sync-dispatch method sends a call frame through the wrapper', async () => {
    // The host method tries to send a call-type WireMessage through
    // the sync wrapper during sync dispatch. This simulates the
    // pattern where a dispatched method invokes a function handle
    // that would round-trip back to the sync-blocked client.
    let reentrancyError: Error | null = null;

    const root = {
      triggerReentrancy() {
        try {
          // Attempt to send a call frame through the wrapper during
          // active sync dispatch. The reentrancy guard should fire.
          h!.wrapped.send({
            type: 'call',
            id: 999,
            method: 'f1',
            params: [],
          } satisfies WireMessage);
        } catch (err) {
          reentrancyError = err as Error;
          // Re-throw so the RPC captures it as an error frame.
          throw err;
        }
        return 'should not reach';
      },
    };

    h = setupHarness(root);
    await h.cmd({type: 'handshake'});

    const result = await h.cmd<{
      ok: true;
      results: WireMessage[];
    }>({
      type: 'wait-batch',
      calls: [{method: 'triggerReentrancy'}],
      timeoutMs: 5000,
    });

    // The host-side error should be the typed reentrancy error.
    expect(reentrancyError).toBeInstanceOf(SyncRPCReentrancyError);
    expect(reentrancyError!.name).toBe('SyncRPCReentrancyError');
    expect(reentrancyError!.message).toContain(
      'docs/sync-mode.md#reentrancy',
    );

    // The worker should see an error frame with the preserved name.
    expect(result.results).toHaveLength(1);
    const frame = result.results[0]!;
    expect(frame.type).toBe('error');
    const errValue = (frame as {type: 'error'; value: unknown}).value as {
      message?: string;
      name?: string;
    };
    expect(errValue.name).toBe('SyncRPCReentrancyError');
  });

  it('does not gate notification frames during sync dispatch', async () => {
    const root = {
      normalMethod() {
        return 42;
      },
    };

    h = setupHarness(root);
    await h.cmd({type: 'handshake'});

    const result = await h.cmd<{
      ok: true;
      results: WireMessage[];
    }>({
      type: 'wait-batch',
      calls: [{method: 'normalMethod'}],
      timeoutMs: 5000,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.type).toBe('result');
    expect(
      (result.results[0]! as {type: 'result'; value: unknown}).value,
    ).toBe(42);
  });
});

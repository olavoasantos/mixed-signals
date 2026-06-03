/**
 * Teardown lifecycle integration tests (M003I008T–M003I011T).
 *
 * These tests exercise the full death-detection chain end-to-end
 * using real `worker_threads` Workers and the production
 * `enableSyncServer` / `enableSyncClient` wrappers.
 */
import {Worker} from 'node:worker_threads';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncServer} from '../../sync/server.ts';

const FIXTURE_URL = new URL('./_teardown-fixture.ts', import.meta.url);

interface Harness {
  worker: Worker;
  rpc: RPC;
  onClientDeadCalls: string[];
  onClientDeadPromise: Promise<string>;
  cmd: <T = unknown>(command: {
    type: string;
    [k: string]: unknown;
  }) => Promise<T>;
  dispose: () => Promise<void>;
}

function setupHarness(
  root: object,
  opts?: {clientId?: string},
): Harness {
  const clientId = opts?.clientId ?? 'test-worker';
  const worker = new Worker(FIXTURE_URL);

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
    send(data, _ctx) {
      worker.postMessage({kind: 'mixed-signals', data});
    },
    onMessage(cb) {
      rpcListeners.push(cb);
    },
  };

  const onClientDeadCalls: string[] = [];
  let resolveClientDead: (id: string) => void;
  const onClientDeadPromise = new Promise<string>((r) => {
    resolveClientDead = r;
  });

  const rpc = new RPC(root);

  function handleWorkerDeath(): void {
    if (onClientDeadCalls.includes(clientId)) return;
    onClientDeadCalls.push(clientId);
    rpc.removeClient(clientId);
    resolveClientDead(clientId);
  }

  const wrapped = enableSyncServer(base, {
    clientId,
    onClientDead(deadClientId) {
      // From the CALLER_STATE poll or postMessage notification path.
      handleWorkerDeath();
    },
  });
  rpc.addClient(wrapped, clientId);

  // Wire up the Node worker bridge for death detection via exit/error.
  // On death, directly invoke the cleanup handler — in the Node
  // topology the bridge and enableSyncServer are co-located.
  worker.on('exit', () => handleWorkerDeath());
  worker.on('error', () => handleWorkerDeath());

  let nextId = 1;
  const readyPromise = new Promise<void>((resolve, reject) => {
    testListeners.push((msg: unknown) => {
      const m = msg as {type: string; error?: string};
      if (m.type === 'ready') resolve();
      if (m.type === 'fatal') {
        reject(new Error(`worker fatal: ${m.error ?? '(no message)'}`));
      }
    });
  });

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
    onClientDeadCalls,
    onClientDeadPromise,
    cmd,
    dispose: async () => {
      await worker.terminate();
    },
  };
}

// ── M003I008T: Worker terminate mid-wait ─────────────────────────────

describe('M003I008T — worker terminate mid-Atomics.wait', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('invokes onClientDead once when worker is terminated mid-wait', async () => {
    let resolveSlowMethod: (() => void) | undefined;
    h = setupHarness({
      slowMethod() {
        return new Promise<string>((resolve) => {
          resolveSlowMethod = () => resolve('too late');
        });
      },
    });

    // Start a sync call that will block on slowMethod.
    const callPromise = h.cmd({
      type: 'sync-call',
      method: 'slowMethod',
    }).catch(() => {
      /* worker terminated — command will fail */
    });

    // Wait a tick for the worker to enter Atomics.wait.
    await new Promise((r) => setTimeout(r, 100));

    // Terminate the worker mid-wait.
    await h.worker.terminate();

    // Wait for the death detection to fire.
    const deadClientId = await Promise.race([
      h.onClientDeadPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('onClientDead not called within 500ms')), 500),
      ),
    ]);

    expect(deadClientId).toBe('test-worker');
    expect(h.onClientDeadCalls).toHaveLength(1);
    expect(h.onClientDeadCalls[0]).toBe('test-worker');
  });
});

// ── M003I009T: HMR scenario (dispose + recreate) ────────────────────

describe('M003I009T — HMR scenario (dispose + recreate)', () => {
  it('rejects stale client_dead from old bridge after new bridge handshakes', async () => {
    const onClientDeadCalls: string[] = [];
    const base: RawTransport = {
      mode: 'raw',
      send() {},
      onMessage() {},
    };

    // Simulate two sequential handshakes on the same enableSyncServer.
    let serverOnMessage:
      | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
      | undefined;
    const sent: unknown[] = [];
    const serverTransport: RawTransport = {
      mode: 'raw',
      send(data) {
        sent.push(data);
      },
      onMessage(cb) {
        serverOnMessage = cb;
      },
    };

    const wrapper = enableSyncServer(serverTransport, {
      onClientDead(id) {
        onClientDeadCalls.push(id);
      },
    });

    // First handshake (bridge A).
    serverOnMessage?.({__sync: 'hs-req'});
    const hsResA = sent.find(
      (m) =>
        typeof m === 'object' &&
        (m as {__sync?: string}).__sync === 'hs-res',
    ) as {epoch: number};
    expect(hsResA).toBeDefined();
    const epochA = hsResA.epoch;
    sent.length = 0;

    // Second handshake (bridge B — simulates HMR recycle).
    serverOnMessage?.({__sync: 'hs-req'});
    const hsResB = sent.find(
      (m) =>
        typeof m === 'object' &&
        (m as {__sync?: string}).__sync === 'hs-res',
    ) as {epoch: number};
    expect(hsResB).toBeDefined();
    const epochB = hsResB.epoch;

    // Epochs must differ.
    expect(epochB).toBeGreaterThan(epochA);

    // Stale notification from bridge A (arrives after bridge B handshake).
    serverOnMessage?.({
      __sync: 'client_dead',
      epoch: epochA,
      clientId: 'old-worker',
    });
    expect(onClientDeadCalls).toHaveLength(0);

    // Valid notification from bridge B.
    serverOnMessage?.({
      __sync: 'client_dead',
      epoch: epochB,
      clientId: 'new-worker',
    });
    expect(onClientDeadCalls).toHaveLength(1);
    expect(onClientDeadCalls[0]).toBe('new-worker');
  });
});

// ── M003I010T: Hard crash recovery via timeoutMs ────────────────────

describe('M003I010T — hard crash recovery via timeoutMs', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('throws SyncRPCTimeoutError when host never responds and no death event fires', async () => {
    h = setupHarness({
      hang() {
        // Never resolves — simulates a hard crash scenario where
        // the host is alive but unresponsive.
        return new Promise(() => {});
      },
    });

    const result = await h.cmd<{
      ok: true;
      errorName: string;
      errorMessage: string;
    }>({
      type: 'sync-call-expect-throw',
      method: 'hang',
      timeoutMs: 100,
    });

    expect(result.errorName).toBe('SyncRPCTimeoutError');
    expect(result.errorMessage).toMatch(/timed out/);

    // onClientDead should NOT have been invoked — the host has no
    // signal that the worker is dead (it's still alive, just timed out).
    expect(h.onClientDeadCalls).toHaveLength(0);
  });
});

// ── M003I011T: Refcount-leak prevention ─────────────────────────────

describe('M003I011T — refcount-leak prevention', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('releases all per-client handles when worker dies after acquiring them', async () => {
    const handles: object[] = [];
    h = setupHarness({
      createHandle(i: number) {
        // Must have methods to be serialized as a handle (tier 2).
        // Plain data objects are inlined and don't create handles.
        const obj = {
          index: i,
          value: `handle-${i}`,
          getValue() {
            return this.value;
          },
        };
        handles.push(obj);
        return obj;
      },
    });

    // Acquire 10 object handles.
    await h.cmd({
      type: 'acquire-handles',
      method: 'createHandle',
      args: [10],
    });

    // Verify handles are registered for this client.
    const handlesBefore = Array.from(h.rpc.handles.allEntries()).filter(
      (e) =>
        e.kind === 'o' &&
        e.id !== 'o0' &&
        e.refs.has('test-worker'),
    );
    expect(handlesBefore.length).toBeGreaterThan(0);

    // Terminate the worker.
    await h.worker.terminate();

    // Wait for death detection + removeClient.
    await Promise.race([
      h.onClientDeadPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('onClientDead not called within 500ms')), 500),
      ),
    ]);

    // After removeClient, no handles should have refs for this client.
    const handlesAfter = Array.from(h.rpc.handles.allEntries()).filter(
      (e) =>
        e.kind === 'o' &&
        e.id !== 'o0' &&
        e.refs.has('test-worker'),
    );
    expect(handlesAfter).toHaveLength(0);
  });
});

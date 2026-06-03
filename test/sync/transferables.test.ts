/**
 * End-to-end tests for the transferable sidecar feature. Validates
 * that Transferable values (ArrayBuffer, MessagePort) round-trip
 * correctly through the sidecar + SAB combination, and that the
 * response-side guardrail emits a clear typed error.
 *
 * Tests run on Node `worker_threads` using the full
 * enableSyncClient + enableSyncServer + RPCClient stack.
 */
import {Worker, MessagePort} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncServer} from '../../sync/server.ts';

const WORKER_URL = new URL('./_transferable-fixture.ts', import.meta.url);

interface Harness {
  worker: Worker;
  rpc: RPC;
  cmd: <T = unknown>(command: {type: string; [k: string]: unknown}) => Promise<T>;
  dispose: () => Promise<void>;
}

function setupHarness(root: object): Harness {
  const worker = new Worker(WORKER_URL);

  const rpcListeners: Array<
    (data: unknown, ctx?: TransportContext) => void | Promise<void>
  > = [];
  const testListeners: Array<(data: unknown) => void> = [];

  worker.on(
    'message',
    (envelope: {kind: string; data: unknown}) => {
      if (envelope?.kind === 'mixed-signals') {
        for (const listener of rpcListeners) listener(envelope.data);
      } else if (envelope?.kind === 'test') {
        for (const listener of testListeners) listener(envelope.data);
      }
    },
  );

  // Host-side transport that propagates ctx.transfer so the sidecar
  // MessagePort in hs-res actually gets transferred to the worker.
  const base: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      const transfer = ctx?.transfer ?? [];
      worker.postMessage(
        {kind: 'mixed-signals', data},
        transfer as any,
      );
    },
    onMessage(cb) {
      rpcListeners.push(cb);
    },
  };

  const wrapped = enableSyncServer(base);
  const rpc = new RPC(root);
  rpc.addClient(wrapped);

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

  function cmd<T>(command: {type: string; [k: string]: unknown}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const listener = (msg: unknown) => {
        const m = msg as {id?: number; ok?: boolean; error?: string; [k: string]: unknown};
        if (m.id !== id) return;
        const idx = testListeners.indexOf(listener);
        if (idx >= 0) testListeners.splice(idx, 1);
        if (m.ok === false || m.error) {
          reject(new Error(m.error ?? 'command failed'));
        } else {
          resolve(m as T);
        }
      };
      testListeners.push(listener);
      worker.postMessage({kind: 'test', data: {...command, id}});
    });
  }

  async function dispose(): Promise<void> {
    await worker.terminate();
  }

  return {worker, rpc, cmd: (c) => readyPromise.then(() => cmd(c)), dispose};
}

// ─── Request-side transferable round-trips ──────────────────────────────

describe('request-side transferable round-trips', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness({
      receiveBuffer(buf: ArrayBuffer) {
        const bytes = new Uint8Array(buf);
        return {
          isArrayBuffer: buf instanceof ArrayBuffer,
          byteLength: buf.byteLength,
          firstByte: bytes.length > 0 ? bytes[0] : null,
          lastByte: bytes.length > 0 ? bytes[bytes.length - 1] : null,
        };
      },
      receivePort(port: MessagePort) {
        // Post a message on the received port to prove it's usable.
        port.postMessage('hello');
        return {isMessagePort: port instanceof MessagePort};
      },
      receiveMixed(num: number, buf: ArrayBuffer, str: string, port: MessagePort) {
        port.postMessage('ack');
        return {
          num,
          bufLength: buf instanceof ArrayBuffer ? buf.byteLength : -1,
          str,
          isPort: port instanceof MessagePort,
        };
      },
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('round-trips an ArrayBuffer with ownership transfer', async () => {
    const result = await harness.cmd<{
      result: {isArrayBuffer: boolean; byteLength: number; firstByte: number; lastByte: number};
      callerDetached: boolean;
    }>({type: 'transfer-arraybuffer'});

    expect(result.result.isArrayBuffer).toBe(true);
    expect(result.result.byteLength).toBe(16);
    expect(result.result.firstByte).toBe(1);
    expect(result.result.lastByte).toBe(16);
    // The caller's original buffer should be detached after transfer.
    expect(result.callerDetached).toBe(true);
  });

  it('round-trips a zero-length ArrayBuffer', async () => {
    const result = await harness.cmd<{
      result: {isArrayBuffer: boolean; byteLength: number};
      callerDetached: boolean;
    }>({type: 'transfer-empty-arraybuffer'});

    expect(result.result.isArrayBuffer).toBe(true);
    expect(result.result.byteLength).toBe(0);
    expect(result.callerDetached).toBe(true);
  });

  it('round-trips a MessagePort with bidirectional communication', async () => {
    const result = await harness.cmd<{
      result: {isMessagePort: boolean};
      receivedMessage: string;
    }>({type: 'transfer-messageport'});

    expect(result.result.isMessagePort).toBe(true);
    expect(result.receivedMessage).toBe('hello');
  });

  it('round-trips mixed args (primitives + transferables)', async () => {
    const result = await harness.cmd<{
      result: {num: number; bufLength: number; str: string; isPort: boolean};
      callerBufferDetached: boolean;
    }>({type: 'transfer-mixed-args'});

    expect(result.result.num).toBe(42);
    expect(result.result.bufLength).toBe(8);
    expect(result.result.str).toBe('hello');
    expect(result.result.isPort).toBe(true);
    expect(result.callerBufferDetached).toBe(true);
  });

  it('round-trips N-arity batch with multiple transferables', async () => {
    const result = await harness.cmd<{
      values: Array<{isArrayBuffer: boolean; byteLength: number; firstByte: number}>;
      allDetached: boolean;
    }>({type: 'transfer-nary-batch'});

    expect(result.values).toHaveLength(3);
    expect(result.values[0]!.byteLength).toBe(4);
    expect(result.values[0]!.firstByte).toBe(1);
    expect(result.values[1]!.byteLength).toBe(4);
    expect(result.values[1]!.firstByte).toBe(5);
    expect(result.values[2]!.byteLength).toBe(4);
    expect(result.values[2]!.firstByte).toBe(9);
    expect(result.allDetached).toBe(true);
  });
});

// ─── Response-side transferable guardrail ────────────────────────────────

describe('response-side transferable guardrail', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness({
      returnBuffer() {
        return new ArrayBuffer(16);
      },
      returnObjectWithBuffer() {
        return {ok: true, buffer: new ArrayBuffer(8)};
      },
      returnSafe() {
        return 'safe-value';
      },
      returnDeepBuffer() {
        return {a: {b: {buffer: new ArrayBuffer(4)}}};
      },
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('throws with a clear message for a root ArrayBuffer return', async () => {
    const result = await harness.cmd<{
      errorName: string;
      errorMessage: string;
    }>({type: 'response-transferable'});

    // The error surfaces on the caller as a hydrated Error. The message
    // carries the SyncRPCResponseTransferableError content from the host.
    expect(result.errorMessage).toContain('Response-side Transferable values are not yet supported');
    expect(result.errorMessage).toContain('ArrayBuffer');
    expect(result.errorMessage).toContain('(root)');
  });

  it('reports the path for a nested transferable return', async () => {
    const result = await harness.cmd<{
      errorName: string;
      errorMessage: string;
    }>({type: 'response-transferable-nested'});

    expect(result.errorMessage).toContain('Response-side Transferable values are not yet supported');
    expect(result.errorMessage).toContain('buffer');
  });

  it('errors per-call in a batch — other calls succeed', async () => {
    const result = await harness.cmd<{
      errorName: string;
      errorMessage: string;
    }>({type: 'response-transferable-batch'});

    // The batch throws the first error (call index 1).
    expect(result.errorMessage).toContain('Response-side Transferable values are not yet supported');
    expect(result.errorMessage).toContain('ArrayBuffer');
  });

  it('reports deeply nested transferable paths', async () => {
    const result = await harness.cmd<{
      errorName: string;
      errorMessage: string;
    }>({type: 'response-transferable-deep'});

    expect(result.errorMessage).toContain('Response-side Transferable values are not yet supported');
    expect(result.errorMessage).toContain('a.b.buffer');
  });
});

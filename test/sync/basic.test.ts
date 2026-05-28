import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RPC} from '../../server/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {createSyncTransportHost} from '../../sync/transport-host.ts';

const WORKER_URL = new URL('./worker-entry.ts', import.meta.url);

interface Harness {
  worker: Worker;
  rpc: RPC;
  ready: Promise<void>;
  call: <T = unknown>(req: {type: string; [k: string]: unknown}) => Promise<T>;
  dispose: () => Promise<void>;
}

function setupHarness(
  root: object,
  opts: {dataSabSize?: number} = {},
): Harness {
  const worker = new Worker(WORKER_URL);
  worker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[worker error]', err);
  });
  worker.on('exit', (code) => {
    if (code !== 0) {
      // eslint-disable-next-line no-console
      console.error('[worker exited]', code);
    }
  });

  // Multiplexed listener: routes mixed-signals envelopes to the RPC
  // transport, test envelopes to the per-request waiter.
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

  const syncHostTransport = createSyncTransportHost({
    base,
    dataSabSize: opts.dataSabSize,
  });
  const rpc = new RPC(root);
  rpc.addClient(syncHostTransport);

  let nextId = 1;
  const ready = new Promise<void>((resolve, reject) => {
    testListeners.push((msg: unknown) => {
      const m = msg as {type: string};
      if (m.type === 'ready') resolve();
      if (m.type === 'fatal')
        reject(
          new Error(
            `worker fatal: ${(msg as {error: string}).error}`,
          ),
        );
    });
  });

  function call<T>(req: {type: string; [k: string]: unknown}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const listener = (msg: unknown) => {
        const m = msg as {type: string; id?: number};
        if (m.id !== id) return;
        const idx = testListeners.indexOf(listener);
        if (idx >= 0) testListeners.splice(idx, 1);
        if (
          (m as {ok?: boolean}).ok === false
        ) {
          reject(new Error((m as {error: string}).error));
        } else {
          resolve(m as T);
        }
      };
      testListeners.push(listener);
      worker.postMessage({kind: 'test', data: {...req, id}});
    });
  }

  const dispose = async () => {
    await worker.terminate();
  };

  return {worker, rpc, ready, call, dispose};
}

describe('sync RPC (Node worker_threads)', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    h = undefined;
  });

  afterEach(async () => {
    if (h) await h.dispose();
    h = undefined;
  });

  it('rpc.wait([rpc.root.now()]) round-trips a primitive', async () => {
    const fixed = 1700000000000;
    h = setupHarness({
      now() {
        return fixed;
      },
    });
    await h.ready;

    const result = await h.call<{value: number}>({type: 'sync-call-now'});
    expect(result.value).toBe(fixed);
  });

  it('rpc.wait([rpc.root.add(a, b)]) round-trips with arguments', async () => {
    h = setupHarness({
      add(a: number, b: number) {
        return a + b;
      },
    });
    await h.ready;

    const result = await h.call<{sum: number}>({
      type: 'sync-call-add',
      args: [3, 4],
    });
    expect(result.sum).toBe(7);
  });

  it('canWait() returns true once the sync transport is wired', async () => {
    h = setupHarness({
      now() {
        return 0;
      },
    });
    await h.ready;

    const result = await h.call<{value: boolean}>({type: 'can-wait'});
    expect(result.value).toBe(true);
  });

  it('rpc.wait receives a multi-chunk response when the result exceeds the data SAB', async () => {
    h = setupHarness(
      {
        bigString(n: number) {
          return 'y'.repeat(n);
        },
      },
      {dataSabSize: 1024},
    );
    await h.ready;

    const result = await h.call<{value: string}>({
      type: 'sync-call-bigstring',
      n: 4096,
    });
    expect(result.value.length).toBe(4096);
    expect(result.value).toBe('y'.repeat(4096));
  });

  it('rpc.wait round-trips a multi-chunk request AND multi-chunk response', async () => {
    h = setupHarness(
      {
        echo(s: string) {
          return s;
        },
      },
      {dataSabSize: 1024},
    );
    await h.ready;

    const payload = 'z'.repeat(5000);
    const result = await h.call<{value: string}>({
      type: 'sync-call-echo',
      arg: payload,
    });
    expect(result.value).toBe(payload);
  });

  it('rpc.wait sends a multi-chunk request when the envelope exceeds the data SAB', async () => {
    // Tiny data SAB so the envelope MUST chunk. A single 1 KiB string
    // alone fills the SAB; the envelope (with JSON framing + handle ids)
    // adds maybe 50 bytes; 4 KiB of payload guarantees 4+ chunks.
    h = setupHarness(
      {
        echoLen(s: string) {
          return s.length;
        },
      },
      {dataSabSize: 1024},
    );
    await h.ready;

    const result = await h.call<{value: number}>({
      type: 'sync-call-echolen',
      arg: 'x'.repeat(4096),
    });
    expect(result.value).toBe(4096);
  });
});

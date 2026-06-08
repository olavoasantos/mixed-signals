/**
 * `RPCClient.wait()` and `canWait()` integration tests.
 *
 * Drive sync calls end-to-end against a real `RPC` server via the
 * `enableSyncServer` / `enableSyncClient` pair, using a Node
 * `worker_threads` Worker as the caller side. The host-side
 * assertions verify:
 *
 *   - Primitive return-values round-trip identically to the async
 *     path.
 *   - Handles returned through `rpc.wait` hydrate as proxies
 *     equivalent to the async path's proxies (same brand semantics).
 *   - N-arity batches return three results in input order.
 *   - Already-consumed promises throw `SyncRPCAlreadyWaitedError`.
 *   - Non-sync transports throw `SyncRPCNoTransportWaitError`.
 *   - Empty batches throw `RangeError`.
 *   - First-error-wins on N-arity batches with mixed success/failure.
 */
import {signal} from '@preact/signals-core';
import {afterEach, describe, expect, it} from 'vitest';
import {RPCClient} from '../../client/rpc.ts';
import {createRawMemoryTransportPair} from '../../server/memory-transport.ts';
import {createModel} from '../../server/model.ts';
import {RPC} from '../../server/rpc.ts';
import {SyncRPCNoTransportWaitError} from '../../sync/errors.ts';
import {MixedSignalsNodeHarness} from '../harness/index.ts';

describe('RPCClient.canWait', () => {
  it('returns false when the transport does not implement wait?', () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    // Construct RPCClient before adding the server so the client is
    // subscribed when `@R` flies (otherwise it's silently dropped).
    const client = new RPCClient(clientT);
    const rpc = new RPC({});
    rpc.addClient(serverT);
    expect(client.canWait()).toBe(false);
    rpc.close();
  });
});

describe('RPCClient.wait — non-sync transports', () => {
  it('throws SyncRPCNoTransportWaitError when transport has no wait?', async () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    const client = new RPCClient(clientT);
    const rpc = new RPC({
      hello() {
        return 'world';
      },
    });
    rpc.addClient(serverT);
    await client.ready;

    expect(() => {
      // The proxy method returns a SyncablePromise, so this is the
      // shape `wait` expects; the missing `wait?` should still throw
      // before the promise is claimed.
      client.wait([client.root.hello()]);
    }).toThrow(SyncRPCNoTransportWaitError);

    rpc.close();
  });

  it('throws RangeError on an empty promises array', () => {
    const [serverT, clientT] = createRawMemoryTransportPair();
    // Inject a fake `wait?` so the no-transport guard passes and we
    // reach the empty-array check.
    const clientTransport: typeof clientT = {
      ...clientT,
      wait() {
        return [];
      },
    };
    const client = new RPCClient(clientTransport);
    const rpc = new RPC({});
    rpc.addClient(serverT);
    expect(() => client.wait([])).toThrow(RangeError);
    rpc.close();
  });
});

describe('RPCClient.wait — end-to-end via Node worker', () => {
  let harness: MixedSignalsNodeHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('round-trips a primitive return value', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        add(a: number, b: number) {
          return a + b;
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [value] = c.wait([c.root.add(2, 3)]);
      return value;
    });
    expect(result).toBe(5);
  });

  it('three primitive-returning calls in one rpc.wait round-trip return three correct results in input order', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        one() {
          return 1;
        },
        two() {
          return 'two';
        },
        three() {
          return true;
        },
      },
      sync: true,
    });
    await harness.ready;

    const values = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      return c.wait([c.root.one(), c.root.two(), c.root.three()]);
    });
    expect(values).toEqual([1, 'two', true]);
  });

  it('hydrates a handle return value as a proxy (same brand semantics as async path)', async () => {
    const Counter = createModel<{value: ReturnType<typeof signal<number>>}>(
      'WaitCounter',
      () => ({value: signal(7)}),
    );
    harness = new MixedSignalsNodeHarness({
      root: {
        makeCounter() {
          return new Counter();
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [handle] = c.wait([c.root.makeCounter()]);
      return {
        typeName: (globalThis as any).typeOfRemote(handle),
        valueOfValue: handle.value.peek(),
      };
    });
    expect(result.typeName).toBe('WaitCounter');
    expect(result.valueOfValue).toBe(7);
  });

  it('throws SyncRPCAlreadyWaitedError when given an already-awaited promise', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        ping() {
          return 'pong';
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(async () => {
      const c = (globalThis as any).client;
      const p = c.root.ping();
      await p; // consume the promise via await
      try {
        c.wait([p]); // try to wait on already-consumed promise
        return {errorName: ''};
      } catch (err) {
        return {errorName: (err as any).name};
      }
    });
    expect(result.errorName).toBe('SyncRPCAlreadyWaitedError');
  });

  it('throws SyncRPCAlreadyWaitedError when given a plain Promise (not a SyncablePromise)', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {},
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      try {
        c.wait([Promise.resolve('plain') as any]);
        return {errorName: ''};
      } catch (err) {
        return {errorName: (err as any).name};
      }
    });
    expect(result.errorName).toBe('SyncRPCAlreadyWaitedError');
  });

  it('first-error-wins on a batch with one failure', async () => {
    harness = new MixedSignalsNodeHarness({
      root: {
        ok() {
          return 'fine';
        },
        bad() {
          throw new Error('detonated');
        },
      },
      sync: true,
    });
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      try {
        c.wait([c.root.ok(), c.root.bad(), c.root.ok()]);
        return {threw: false, errorMessage: ''};
      } catch (err) {
        return {threw: true, errorMessage: (err as any).message};
      }
    });
    expect(result.errorMessage).toBe('detonated');
  });
});

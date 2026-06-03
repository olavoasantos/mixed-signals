import {describe, expect, it, afterEach} from 'vitest';
import {signal} from '@preact/signals-core';
import {createModel} from '../../server/model.ts';
import {MixedSignalsNodeHarness} from './mixed-signals-harness.ts';
import {createPortChannelPair} from './env/port-channel.ts';
import {TestProcessEnv} from './env/test-process.ts';
import {createStringTransport} from './mixed-signals-harness.ts';
import {RPC} from '../../server/rpc.ts';
import {RPCClient} from '../../client/rpc.ts';

const Counter = createModel('Counter', () => {
  const count = signal(0);
  return {
    count,
    increment() {
      count.value++;
    },
  };
});

describe('MixedSignalsNodeHarness', () => {
  let harness: MixedSignalsNodeHarness;

  afterEach(async () => {
    await harness?.terminate();
  });

  it('client can call server methods through the worker boundary', async () => {
    const root = new Counter();
    harness = new MixedSignalsNodeHarness({root});
    await harness.ready;

    await harness.client.evaluate(async () => {
      await (globalThis as any).client.root.increment();
    });

    expect(root.count.value).toBe(1);
  });

  it('client sees server signal state after subscribing', async () => {
    const root = new Counter();
    harness = new MixedSignalsNodeHarness({root});
    await harness.ready;

    // Subscribe to the signal on the client side, then mutate on the server
    await harness.client.evaluate(async () => {
      (globalThis as any).client.root.count.subscribe(() => {});
    });

    // Small delay for the watch notification to cross the wire
    await new Promise((r) => setTimeout(r, 50));

    root.count.value = 42;

    // Allow the signal update to propagate
    await new Promise((r) => setTimeout(r, 50));

    const clientCount = await harness.client.evaluate(async () => {
      return (globalThis as any).client.root.count.peek();
    });

    expect(clientCount).toBe(42);
  });

  it('multiple method calls accumulate', async () => {
    const root = new Counter();
    harness = new MixedSignalsNodeHarness({root});
    await harness.ready;

    await harness.client.evaluate(async () => {
      const c = (globalThis as any).client;
      await c.root.increment();
      await c.root.increment();
      await c.root.increment();
    });

    expect(root.count.value).toBe(3);
  });
});

describe('MixedSignalsNodeHarness (sync mode)', () => {
  let harness: MixedSignalsNodeHarness;

  afterEach(async () => {
    await harness?.terminate();
  });

  it('sync call round-trips a primitive return value', async () => {
    const root = {
      add(a: number, b: number) {
        return a + b;
      },
    };
    harness = new MixedSignalsNodeHarness({root, sync: true});
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [value] = c.wait([c.root.add(2, 3)]);
      return value;
    });

    expect(result).toBe(5);
  });

  it('N-arity sync batch returns results in input order', async () => {
    const root = {
      one() { return 1; },
      two() { return 'two'; },
      three() { return true; },
    };
    harness = new MixedSignalsNodeHarness({root, sync: true});
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      return c.wait([
        c.root.one(),
        c.root.two(),
        c.root.three(),
      ]);
    });

    expect(result).toEqual([1, 'two', true]);
  });

  it('sync call observes server signal mutation via drain barrier', async () => {
    const counter = signal(0);
    const ServerModel = createModel<{counter: typeof counter}>(
      'Server',
      () => ({counter}),
    );
    const server = new ServerModel();

    const root = {
      server,
      mutate() {
        counter.value = 42;
        return 'done';
      },
    };
    harness = new MixedSignalsNodeHarness({root, sync: true});
    await harness.ready;

    // Subscribe to the signal first (so the drain barrier captures @S frames)
    await harness.client.evaluate(async () => {
      const c = (globalThis as any).client;
      c.root.server.counter.subscribe(() => {});
      // Wait for the @W subscription to propagate
      await new Promise((r: any) => setTimeout(r, 50));
    });

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      const [value] = c.wait([c.root.mutate()]);
      // After wait returns, the signal should reflect the mutation
      const signalValue = c.root.server.counter.peek();
      return {value, signalValue};
    });

    expect(result.value).toBe('done');
    expect(result.signalValue).toBe(42);
  });

  it('method that throws produces an error visible to the caller', async () => {
    const root = {
      boom() {
        throw new Error('kaboom');
      },
    };
    harness = new MixedSignalsNodeHarness({root, sync: true});
    await harness.ready;

    const result = await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      try {
        c.wait([c.root.boom()]);
        return {threw: false};
      } catch (err: any) {
        return {threw: true, message: err.message};
      }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toBe('kaboom');
  });

  it('multiple sequential sync calls succeed (state cleanly resets)', async () => {
    const root = new Counter();
    harness = new MixedSignalsNodeHarness({root, sync: true});
    await harness.ready;

    await harness.client.evaluate(() => {
      const c = (globalThis as any).client;
      c.wait([c.root.increment()]);
      c.wait([c.root.increment()]);
      c.wait([c.root.increment()]);
    });

    expect(root.count.value).toBe(3);
  });

  it('async calls still work alongside sync capability', async () => {
    const root = new Counter();
    harness = new MixedSignalsNodeHarness({root, sync: true});
    await harness.ready;

    await harness.client.evaluate(async () => {
      const c = (globalThis as any).client;
      await c.root.increment();
    });

    expect(root.count.value).toBe(1);
  });

  it('exposes syncTransport for server-side access', () => {
    const root = {};
    harness = new MixedSignalsNodeHarness({root, sync: true});
    expect(harness.syncTransport).toBeDefined();
  });

  it('syncTransport is undefined in async mode', () => {
    const root = {};
    harness = new MixedSignalsNodeHarness({root});
    expect(harness.syncTransport).toBeUndefined();
  });
});

describe('createStringTransport (unit)', () => {
  it('wires RPC through a paired channel', async () => {
    // Unit test: verify the transport adapter works with a paired channel.
    // E2e tests through the full harness use the MixedSignals*Harness classes.
    const [a, b] = createPortChannelPair();
    const envA = new TestProcessEnv();
    const envB = new TestProcessEnv();

    // Override delivers to use the paired channels
    envA.channel.setDeliver((data) => b.receive(data));
    envB.channel.setDeliver((data) => a.receive(data));
    a.onReceive = (data) => envA.channel.receive(data);
    b.onReceive = (data) => envB.channel.receive(data);

    const root = new Counter();
    const server = new RPC(root);
    server.addClient(createStringTransport(envA), 'c1');

    const client = new RPCClient(createStringTransport(envB));
    await client.ready;

    expect(client.root).toBeDefined();
    expect(client.root.count.peek()).toBe(0);

    await client.root.increment();
    expect(root.count.peek()).toBe(1);

    server.removeClient('c1');
  });
});

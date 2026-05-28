import {describe, expect, it} from 'vitest';
import {
  SyncablePromise,
  claimForSync,
  settleSyncable,
} from '../../sync/syncable-promise.ts';
import {SyncRPCAlreadyWaitedError} from '../../sync/errors.ts';

function spy() {
  let calls = 0;
  let lastArg: unknown = undefined;
  const fn = (arg?: unknown) => {
    calls++;
    lastArg = arg;
  };
  return {
    fn,
    get calls() {
      return calls;
    },
    get lastArg() {
      return lastArg;
    },
  };
}

describe('SyncablePromise', () => {
  it('does not invoke asyncSend synchronously at construction (queued for next microtask)', () => {
    const sent = spy();
    new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    // Send is queued via queueMicrotask, so it hasn't fired *yet*.
    expect(sent.calls).toBe(0);
  });

  it('auto-fires asyncSend one microtask after construction (prototype semantics B)', async () => {
    const sent = spy();
    new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    await Promise.resolve();
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend when consumed by `await` (.then, one microtask later)', async () => {
    let resolveSent: ((v: string) => void) | undefined;
    const p = new SyncablePromise<string>({method: 'foo', args: []}, (s) => {
      resolveSent = s.resolve as (v: string) => void;
    });

    // `await p` queues PromiseResolveThenableJob, which calls .then in the
    // next microtask. Flushing one microtask is enough to observe the send.
    const awaited = (async () => await p)();
    await Promise.resolve();
    expect(resolveSent).toBeDefined();

    resolveSent!('hello');
    expect(await awaited).toBe('hello');
  });

  it('fires asyncSend when consumed by .catch', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    void p.catch(() => undefined);
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend when consumed by .finally', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    void p.finally(() => undefined);
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend exactly once across multiple .then calls', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    void p.then(() => undefined);
    void p.then(() => undefined);
    void p.then(() => undefined);
    expect(sent.calls).toBe(1);
  });

  it('fires asyncSend when used in Promise.all (microtask-deferred)', async () => {
    let resolveA: ((v: number) => void) | undefined;
    let resolveB: ((v: number) => void) | undefined;
    const a = new SyncablePromise<number>({method: 'a', args: []}, (s) => {
      resolveA = s.resolve as (v: number) => void;
    });
    const b = new SyncablePromise<number>({method: 'b', args: []}, (s) => {
      resolveB = s.resolve as (v: number) => void;
    });

    // Same story as `await`: Promise.all routes through PromiseResolve which
    // queues a thenable job because SyncablePromise.constructor !== %Promise%.
    const combined = Promise.all([a, b]);
    await Promise.resolve();
    expect(resolveA).toBeDefined();
    expect(resolveB).toBeDefined();
    resolveA!(1);
    resolveB!(2);
    expect(await combined).toEqual([1, 2]);
  });

  it('claimForSync (synchronous, same tick) wins the race against auto-fire', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>(
      {method: 'foo', args: [1, 'two']},
      sent.fn,
    );
    // Synchronously claim before the auto-fire microtask runs.
    const desc = claimForSync(p);
    expect(desc).toEqual({method: 'foo', args: [1, 'two']});
    // Flush microtasks; auto-fire should have bailed because consumed=true.
    await Promise.resolve();
    expect(sent.calls).toBe(0);
  });

  it('claimForSync after a microtask elapses throws (auto-fire already won)', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    await Promise.resolve();
    expect(sent.calls).toBe(1);
    expect(() => claimForSync(p)).toThrow(SyncRPCAlreadyWaitedError);
  });

  it('claimForSync after .then throws SyncRPCAlreadyWaitedError', () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    void p.then(() => undefined);
    expect(() => claimForSync(p)).toThrow(SyncRPCAlreadyWaitedError);
  });

  it('.then after claimForSync does not re-fire asyncSend', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    claimForSync(p);
    void p.then(() => undefined);
    await Promise.resolve();
    // No async send: sync claimed first; auto-fire microtask bailed.
    expect(sent.calls).toBe(0);
  });

  it('settleSyncable resolves a sync-claimed promise', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    claimForSync(p);
    settleSyncable(p, {ok: true, value: 'hi'});
    expect(await p).toBe('hi');
  });

  it('settleSyncable rejects a sync-claimed promise', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    claimForSync(p);
    settleSyncable(p, {ok: false, error: new Error('boom')});
    await expect(p).rejects.toThrow('boom');
  });

  it('claimForSync twice throws SyncRPCAlreadyWaitedError', () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    claimForSync(p);
    expect(() => claimForSync(p)).toThrow(SyncRPCAlreadyWaitedError);
  });

  it('.then result is a plain Promise (not SyncablePromise)', async () => {
    const sent = spy();
    const p = new SyncablePromise<string>({method: 'foo', args: []}, sent.fn);
    const chained = p.then((v) => v.toUpperCase());
    expect(chained).not.toBeInstanceOf(SyncablePromise);
    expect(chained).toBeInstanceOf(Promise);
  });
});

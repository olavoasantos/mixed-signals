import {SyncRPCAlreadyWaitedError} from './errors.ts';

/**
 * Descriptor of a deferred RPC call: what we'd send if/when consumed.
 */
export interface SyncableCallDescriptor {
  /** Method name (dotted path or `<id>#method`). */
  method: string;
  args: readonly unknown[];
}

/**
 * Internal sentinel keys. Not exported — `RPCClient` accesses these via
 * the `getSyncableInternals(p)` helper below to keep the hook surface
 * private to this module.
 */
const STATE = Symbol('SyncablePromise.state');

interface SyncableInternals<T> {
  descriptor: SyncableCallDescriptor;
  /** Has this promise been claimed yet? */
  consumed: boolean;
  /** Which path claimed it (debugging / error messages). */
  consumer: 'async' | 'sync' | 'auto' | null;
  /** Resolve/reject the outer Promise. */
  resolve: (v: T | PromiseLike<T>) => void;
  reject: (e: unknown) => void;
  /**
   * Wire send for the async path. Set by the constructor's caller (the
   * RPCClient). Called when the first consumer is `await` / `.then` /
   * `.catch` / `.finally`, OR via the auto-fire microtask if nothing
   * else has claimed first.
   */
  asyncSend: (settle: {
    resolve: (v: T | PromiseLike<T>) => void;
    reject: (e: unknown) => void;
  }) => void;
}

/** Internal: fire async send for an unconsumed promise. */
function fireAsync<T>(
  s: SyncableInternals<T>,
  consumer: 'async' | 'auto',
): void {
  if (s.consumed) return;
  s.consumed = true;
  s.consumer = consumer;
  try {
    s.asyncSend({resolve: s.resolve, reject: s.reject});
  } catch (err) {
    s.reject(err);
  }
}

/**
 * A `Promise<T>` that hasn't sent its wire request yet. The first consumer
 * — either the JS `await` keyword (via `.then`) or `RPCClient#wait` — wins
 * and triggers the send. Second consumer throws `SyncRPCAlreadyWaitedError`.
 *
 * **Prototype semantics note (departure from design.md §3 strict-lazy):**
 * the wire send is queued as a microtask at construction time. If a
 * synchronous `rpc.wait([p])` claims first, the microtask sees `consumed`
 * and bails. Otherwise (the common case), the send fires automatically
 * one microtask later — preserving the eager ergonomics existing tests
 * (and most user code) rely on. Strict-lazy is recoverable: drop the
 * auto-fire microtask and require explicit consumption.
 *
 * Implementation notes:
 *
 * - We subclass `Promise<T>` so existing async code (`await rpc.foo()`,
 *   `Promise.all([rpc.foo(), rpc.bar()])`, etc.) keeps working unchanged.
 * - `.then` / `.catch` / `.finally` all route through `.then`; we override
 *   it to claim before the auto-fire microtask runs.
 * - `Symbol.species` is set to the base `Promise` so chained promises
 *   (`p.then(x => ...)`) don't become `SyncablePromise`s themselves.
 *   Otherwise `rpc.wait([p.then(...)])` would type-check but semantically
 *   make no sense (the call already fired).
 */
export class SyncablePromise<T> extends Promise<T> {
  /** @internal */
  private [STATE]!: SyncableInternals<T>;

  constructor(
    descriptor: SyncableCallDescriptor,
    asyncSend: SyncableInternals<T>['asyncSend'],
  ) {
    let captured!: {
      resolve: (v: T | PromiseLike<T>) => void;
      reject: (e: unknown) => void;
    };
    super((resolve, reject) => {
      captured = {resolve, reject};
    });
    const state: SyncableInternals<T> = {
      descriptor,
      consumed: false,
      consumer: null,
      resolve: captured.resolve,
      reject: captured.reject,
      asyncSend,
    };
    this[STATE] = state;
    // Auto-fire: queue the send as a microtask. A synchronous claim
    // (`rpc.wait([p])`) or a synchronous `.then` consumes first and the
    // microtask sees `consumed === true` and bails.
    queueMicrotask(() => fireAsync(state, 'auto'));
  }

  /**
   * Chained promises must not inherit `SyncablePromise` semantics — a
   * `.then` result is already-fired downstream work, not a wait candidate.
   */
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  override then<TResult1 = T, TResult2 = never>(
    onFulfilled?:
      | ((value: T) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): Promise<TResult1 | TResult2> {
    fireAsync(this[STATE], 'async');
    // If consumed by sync or already auto-fired, .then just chains onto
    // the already-resolving promise.
    return super.then(onFulfilled, onRejected);
  }
}

/** Type guard for `SyncablePromise`. */
export function isSyncablePromise(
  value: unknown,
): value is SyncablePromise<unknown> {
  return value instanceof SyncablePromise;
}

// ── Internal hooks (consumed by RPCClient via these named helpers) ────────

/**
 * Claim a `SyncablePromise` for the sync path. Returns the call descriptor
 * so `RPCClient#wait` can batch it into the SAB envelope. Throws if the
 * promise has already been consumed by either path.
 *
 * @internal
 */
export function claimForSync(
  p: SyncablePromise<unknown>,
): SyncableCallDescriptor {
  const s = (p as unknown as {[STATE]: SyncableInternals<unknown>})[STATE];
  if (s.consumed) {
    throw new SyncRPCAlreadyWaitedError(
      `SyncablePromise already consumed by ${s.consumer ?? 'unknown path'}`,
    );
  }
  s.consumed = true;
  s.consumer = 'sync';
  return s.descriptor;
}

/**
 * Settle a sync-claimed `SyncablePromise` from the response timeline. The
 * promise's `.then`/`.catch` chain runs as usual; `await` resolves with
 * `value` (or rejects with `error`).
 *
 * @internal
 */
export function settleSyncable<T>(
  p: SyncablePromise<T>,
  result: {ok: true; value: T} | {ok: false; error: unknown},
): void {
  const s = (p as unknown as {[STATE]: SyncableInternals<T>})[STATE];
  if (result.ok) s.resolve(result.value);
  else s.reject(result.error);
}

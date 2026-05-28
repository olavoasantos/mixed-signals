import {
  hydrateTree,
  PeerCodec,
  substituteBrandsAndCollectTransferables,
} from '../shared/codec.ts';
import {Hydrator} from '../shared/hydrate.ts';
import {
  PROMISE_REJECT_METHOD,
  PROMISE_RESOLVE_METHOD,
  ROOT_NOTIFICATION_METHOD,
  SIGNAL_UPDATE_METHOD,
  type Transport,
  type TransportContext,
  type WireMessage,
} from '../shared/protocol.ts';
import {
  SyncRPCAlreadyWaitedError,
  SyncRPCNoTransportWaitError,
} from '../sync/errors.ts';
import {
  claimForSync,
  isSyncablePromise,
  settleSyncable,
  type SyncablePromise,
} from '../sync/syncable-promise.ts';
import {ClientReflection} from './reflection.ts';

/**
 * Client-side RPC hub.
 *
 * No model registration is required. Every incoming value is hydrated
 * automatically — Models and plain objects become `Proxy`s, functions become
 * callable proxies, promises become live `Promise`s, signals become real
 * `Signal`s wired to the watch/unwatch protocol.
 *
 * Works with either a `StringTransport` (the default — WebSocket, stdio,
 * etc.) or a `RawTransport` (postMessage / MessagePort / Worker). On the
 * raw path, outbound calls walk the arg tree to substitute branded remote
 * handles with `@H` markers and collect Transferable values into
 * `ctx.transfer`, which the transport hands to `postMessage(msg, ctx)`.
 */
export class RPCClient {
  private codec: PeerCodec;
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<
    number,
    {resolve(v: any): void; reject(e: any): void}
  >();
  private notificationListeners = new Set<
    (method: string, params: any[]) => void
  >();

  /** @internal */
  reflection: ClientReflection;
  /** @internal */
  hydrator: Hydrator;

  private transportReady: Promise<void> | undefined;
  root: any = undefined;
  ready: Promise<void>;
  private _resolveReady!: () => void;

  constructor(transport: Transport, _ctx?: any) {
    this.transport = transport;
    this.transportReady = transport.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.reflection = new ClientReflection(this);
    this.hydrator = new Hydrator(this.reflection);
    this.reflection.setHydrator(this.hydrator);
    this.codec = new PeerCodec(transport, (marker) =>
      this.hydrator.hydrate(marker),
    );
    this.wireCodec();
  }

  reconnect(transport: Transport) {
    this.transport = transport;
    this.transportReady = transport.ready;
    for (const {reject} of this.pending.values()) {
      reject(new Error('Transport reconnected'));
    }
    this.pending.clear();
    this.reflection.reset();
    this.hydrator.reset();
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.codec = new PeerCodec(transport, (marker) =>
      this.hydrator.hydrate(marker),
    );
    this.wireCodec();
  }

  private wireCodec() {
    this.codec.onMessage((msg) => {
      if (msg.type === 'result') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending.resolve(msg.value);
        return;
      }
      if (msg.type === 'error') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        pending.reject(
          new Error(
            ((msg.value as {message?: string}) ?? {}).message ?? 'RPC error',
          ),
        );
        return;
      }
      if (msg.type === 'call') return;

      this.handleNotification(msg.method, msg.params as any[]);
    });
  }

  async call(method: string, params?: any): Promise<any> {
    if (this.transportReady) await this.transportReady;
    return new Promise((resolve, reject) => {
      this._sendCall(method, params, {resolve, reject});
    });
  }

  /**
   * @internal — fire one wire call with externally-provided settle
   * handlers. Shared between `call` (eager, async API) and
   * `ClientReflection.callSyncable` (deferred, via `SyncablePromise`).
   *
   * Does NOT await `transportReady`. Callers that need to defer until
   * ready should chain on `this.transportReady` first; the `call` method
   * does this. The lazy-send path of `SyncablePromise` chains on it via
   * the `asyncSend` callback.
   */
  _sendCall(
    method: string,
    params: unknown[] | undefined,
    settle: {resolve(v: any): void; reject(e: any): void},
  ): void {
    const fire = () => {
      const id = this.nextId++;
      this.pending.set(id, settle);
      const ctx: TransportContext = {};
      const walked = substituteBrandsAndCollectTransferables(
        params || [],
        ctx,
        this.codec.encode,
      ) as unknown[];
      this.codec.send({type: 'call', id, method, params: walked}, ctx);
    };
    if (this.transportReady) {
      this.transportReady.then(fire, settle.reject);
    } else {
      fire();
    }
  }

  /**
   * Resolve the constructor for a remote class by name. Every class instance
   * the client has hydrated is built on a shared prototype, so you can use
   * the returned function with `instanceof`:
   *
   *   const Counter = client.classOf('Counter');
   *   value instanceof Counter;
   *
   * Returns `undefined` if no instance of a class with that name has been
   * received yet.
   */
  classOf(name: string): (new () => any) | undefined {
    return this.hydrator.classOf(name);
  }

  notify(method: string, params?: any[]) {
    const sendIt = () => {
      const ctx: TransportContext = {};
      const walked = substituteBrandsAndCollectTransferables(
        params || [],
        ctx,
        this.codec.encode,
      ) as unknown[];
      this.codec.send({type: 'notification', method, params: walked}, ctx);
    };
    if (this.transportReady) {
      this.transportReady.then(sendIt);
    } else {
      sendIt();
    }
  }

  /**
   * True iff this client's transport implements `wait?`. Doesn't itself
   * check the context (use `supportsSync()` from `mixed-signals/sync` for
   * that); a transport's `wait?` may or may not be callable from the
   * current realm.
   */
  canWait(): boolean {
    return typeof this.transport.wait === 'function';
  }

  /**
   * Synchronously block on one or more in-flight RPC promises, resolving
   * them via a single SAB round-trip. See `mixed-signals/sync` for the
   * topology + setup story.
   *
   * Prototype scope: single-chunk envelopes only.
   */
  wait<T extends readonly SyncablePromise<unknown>[]>(
    promises: T,
    opts?: {timeoutMs?: number},
  ): {
    [K in keyof T]: T[K] extends SyncablePromise<infer R> ? R : never;
  } {
    if (typeof this.transport.wait !== 'function') {
      throw new SyncRPCNoTransportWaitError(
        'transport does not implement wait()',
      );
    }

    // Claim each promise for sync (throws if any already consumed).
    const claimed: Array<{
      promise: SyncablePromise<unknown>;
      descriptor: ReturnType<typeof claimForSync>;
    }> = [];
    for (const p of promises) {
      if (!isSyncablePromise(p)) {
        throw new SyncRPCAlreadyWaitedError(
          'rpc.wait(...) requires SyncablePromises from this client\'s proxy',
        );
      }
      claimed.push({promise: p, descriptor: claimForSync(p)});
    }

    // Build outbound WireMessages with brands substituted. Each gets a
    // fresh wire id from the same counter the async path uses, so the host
    // can't observe an id collision.
    const calls: WireMessage[] = claimed.map(({descriptor}) => {
      const ctx: TransportContext = {};
      const walkedParams = substituteBrandsAndCollectTransferables(
        descriptor.args,
        ctx,
        this.codec.encode,
      ) as unknown[];
      return {
        type: 'call',
        id: this.nextId++,
        method: descriptor.method,
        params: walkedParams,
      };
    });

    const results = this.transport.wait(calls, opts);

    // Hydrate each result through the same path inbound messages take.
    const hydrate = (v: unknown) =>
      hydrateTree(
        v,
        (marker) => this.hydrator.hydrate(marker),
        this.transport.decode,
      );

    // Settle every claimed promise FIRST, then throw on the first error.
    // If we throw mid-loop, later promises stay claimed-but-unsettled and
    // `await` on them hangs forever. Mirrors `Promise.all` semantics in
    // spirit (first error wins) but adapted to a batch we already have
    // all responses for.
    const out: unknown[] = new Array(results.length);
    let firstError: Error | undefined;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const {promise} = claimed[i];
      if (r.type === 'result') {
        const hydrated = hydrate(r.value);
        settleSyncable(promise, {ok: true, value: hydrated});
        out[i] = hydrated;
      } else if (r.type === 'error') {
        const hydrated = hydrate(r.value) as {message?: string} | undefined;
        const err = new Error(hydrated?.message ?? 'RPC error');
        settleSyncable(promise, {ok: false, error: err});
        out[i] = undefined;
        if (!firstError) firstError = err;
      } else {
        throw new Error(
          `unexpected sync response type "${(r as {type: string}).type}"`,
        );
      }
    }
    if (firstError) throw firstError;
    return out as {
      [K in keyof T]: T[K] extends SyncablePromise<infer R> ? R : never;
    };
  }

  onNotification(cb: (method: string, params: any[]) => void): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  private handleNotification(method: string, params: any[]) {
    if (method === ROOT_NOTIFICATION_METHOD) {
      this.root = params[0];
      this._resolveReady();
    } else if (method === SIGNAL_UPDATE_METHOD) {
      const [id, value, mode] = params as [string, any, string?];
      this.hydrator.applySignalUpdate(id, value, mode);
    } else if (method === PROMISE_RESOLVE_METHOD) {
      const [id, value] = params as [string, any];
      this.reflection.settlePromise(id, value, false);
    } else if (method === PROMISE_REJECT_METHOD) {
      const [id, value] = params as [string, any];
      this.reflection.settlePromise(id, value, true);
    } else {
      for (const listener of this.notificationListeners) {
        listener(method, params);
      }
    }
  }
}

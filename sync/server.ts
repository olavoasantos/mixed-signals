import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../shared/protocol.ts';
import {
  allocateLane,
  CALLER_STATE,
  CHUNK_STATE,
  CTRL,
  DEFAULT_DATA_SAB_BYTES,
  loadCtrl,
  storeCtrl,
} from './lane.ts';
import {SyncRPCResponseTransferableError} from './errors.ts';
import {ReplayLog} from './replay-log.ts';
import {
  collectExpectedTransferIds,
  findTransferableInValue,
  reconstructTransferables,
  type SidecarMessage,
} from './transferables.ts';

/**
 * Extended transport returned by `enableSyncServer`. Carries the
 * standard `RawTransport` surface plus `markDead` — a co-located
 * lifecycle seam for topologies where the detection site and the
 * server share a process (e.g., Node `worker_threads`).
 */
export interface SyncServerTransport extends RawTransport {
  /**
   * Mark a client as dead from a co-located lifecycle owner. Stores
   * `CALLER_STATE = DEAD` in the SAB, aborts any active batch, and
   * invokes `onClientDead`. Idempotent — safe to call multiple
   * times for the same clientId.
   *
   * Iframe bridges reach the same cleanup via the postMessage
   * `client_dead` envelope; this method is the direct equivalent
   * for in-process detection sites.
   */
  markDead(clientId: string): void;
}

/**
 * Out-of-band sync-transport control frames carried over the base
 * postMessage transport. Distinguished from regular `WireMessage`s by
 * the reserved `__sync` field on the envelope.
 *
 * @internal
 */
type SyncControl =
  | {__sync: 'hs-req'}
  | {
      __sync: 'hs-res';
      control: SharedArrayBuffer;
      data: SharedArrayBuffer;
      epoch: number;
      sidecar?: MessagePort;
    }
  | {__sync: 'doorbell'; seq: number}
  | {__sync: 'pull'; seq: number}
  | {__sync: 'frame'; seq: number; msg: WireMessage}
  | {__sync: 'client_dead'; epoch: number; clientId: string};

function isSyncControl(data: unknown): data is SyncControl {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as {__sync?: unknown}).__sync === 'string'
  );
}

/**
 * Per-batch state. Lives in a closure created by
 * `serviceSyncRequest` and is referenced by the host-wrapper's
 * `activeBatch` slot for the duration of one sync round-trip
 * (doorbell → dispatch → capture → response chunks → final pull).
 *
 * Promoting the per-batch state from module-scope vars into an
 * object held by a single `activeBatch` slot is the structural fix
 * for the previous "caller-timeout leaks suspended async frame"
 * bug: if a NEW doorbell arrives while a prior batch is still
 * awaiting its responses, the old batch is marked `aborted = true`
 * and its `resolve` is called, which lets the suspended
 * `serviceSyncRequest` frame run to completion without publishing.
 * The next batch creates a fresh context; nothing leaks.
 *
 * @internal
 */
interface BatchContext {
  seq: number;
  /** Synth ids assigned to this batch's calls, in input order. */
  orderedIds: number[];
  /** Synth ids the wrapper expects to capture for this batch. */
  expected: Set<number>;
  /** Captured `result` / `error` frames keyed by synth id. */
  captured: Map<number, WireMessage>;
  /**
   * Side-effect notification frames (`@S`, `@P`, `@E`, etc.) captured
   * during the active sync batch, in emission order. These are interleaved
   * with results in the response timeline.
   */
  timeline: WireMessage[];
  /** Resolves when `captured.size === expected.size` OR `aborted`. */
  done: Promise<void>;
  resolve: () => void;
  /**
   * Set by `handleHandshake` or by `serviceSyncRequest` when a new
   * doorbell arrives mid-flight. Causes the suspended dispatch
   * frame to bail before publishing its (no-longer-wanted) response.
   */
  aborted: boolean;
  /**
   * True after the response timeline has been serialized. Once frozen,
   * new notifications must route through the idle path (replay log)
   * instead of being captured into batch.timeline — the bytes are
   * already encoded and pushing into the array is a no-op. This
   * separates the capture lifetime from the response-delivery lifetime.
   */
  timelineFrozen: boolean;
  /**
   * Pending response chunks awaiting `pull` doorbells. Non-null
   * after `serviceSyncRequest` publishes the first chunk; nulled
   * after the final chunk is written.
   */
  responseQueue: {bytes: Uint8Array; offset: number} | null;
}

/**
 * Server-side: wraps a base `RawTransport` with a sync-capable
 * `Transport`. Pass the result to `rpc.addClient(...)`.
 *
 * The wrapper is inactive until the caller initiates the SAB handshake
 * via `enableSyncClient(...)` from a worker. Until that handshake fires,
 * every inbound and outbound frame passes through to the base transport
 * unchanged — the wrapper is indistinguishable from the base for
 * async-only callers.
 *
 * Once the handshake completes, the wrapper services sync calls by:
 *
 *   - Reading each request envelope from the data SAB via the six-state
 *     chunk machine (one chunk per inbound `{__sync: 'doorbell', seq}`).
 *   - Synthesizing one inbound `call` `WireMessage` per batch entry into
 *     the host RPC by invoking the callback `rpc.addClient(...)` wired
 *     into the wrapper's `onMessage`. The host RPC dispatches normally —
 *     it has no awareness of the sync mode.
 *   - Capturing matching outbound `result` / `error` frames (matched by
 *     synthesized id) while the active sync batch is in flight, instead
 *     of forwarding them to the base transport. All other outbound
 *     frames (notifications + responses for non-sync calls) pass through
 *     unchanged.
 *   - Once every expected response has been captured, encoding the
 *     response timeline and writing it back to the data SAB via the
 *     chunk machine (one chunk per inbound `{__sync: 'pull', seq}`,
 *     except the first chunk which goes out eagerly after dispatch).
 *
 * Synthesized inbound `call` ids start at 1,000,000 and increment
 * monotonically across batches, so they do not collide with the host
 * RPC's own client-side id space.
 *
 * **One in-flight batch.** All per-batch state lives in a
 * `BatchContext` referenced by the wrapper's `activeBatch` slot.
 * If a new doorbell arrives while `activeBatch !== null` (the
 * caller timed out, threw, and is retrying), the prior batch is
 * marked `aborted` and its `done` is resolved so the suspended
 * `serviceSyncRequest` frame can finish without publishing. The
 * new batch then starts fresh. This is what closes the host-side
 * suspended-frame leak previously caused by writing per-batch
 * state into module-scope vars.
 *
 * **Handshake re-request.** If `hs-req` arrives more than once on the
 * same wrapper instance (e.g., a caller-side reconnect with a fresh
 * `RPCClient`), the wrapper reuses the existing SAB pair if one has
 * already been allocated, allocating fresh only on the first `hs-req`.
 * This is necessary because the worker holds references to the SABs it
 * received on the first `hs-res`; replacing them server-side would
 * leave the worker talking to dead memory. Any in-flight batch is
 * aborted on rehandshake and the request accumulator is cleared.
 *
 * **Non-sync pass-through.** Frames that do not carry a `__sync` field
 * are forwarded to / from the base transport unchanged, in both
 * directions. The existing async RPC dispatch path is unaffected.
 *
 * @throws RangeError when `opts.dataSabSize` is not an integer in the
 *   `[MIN_DATA_SAB_BYTES, MAX_DATA_SAB_BYTES]` range (validated by
 *   `allocateLane` on first `hs-req`).
 */
export function enableSyncServer(
  transport: RawTransport,
  opts?: {
    dataSabSize?: number;
    /**
     * Stable client identifier for this lane. When provided, the
     * host-side CALLER_STATE poll can invoke `onClientDead` even
     * before the postMessage notification arrives. If omitted, the
     * SAB poll path silently drops the notification (the postMessage
     * path still works via the envelope's `clientId` field).
     */
    clientId?: string;
    /**
     * Called when a worker dies mid-call. Wire this to
     * `rpc.removeClient(clientId)` to release per-client handles.
     * The wrapper never holds an upward reference to the RPC
     * instance; this callback is the decoupling seam.
     */
    onClientDead?: (clientId: string) => void;
    /**
     * Maximum milliseconds to wait for sidecar transferable values
     * to arrive after a doorbell containing `@T:'transfer'` sentinels.
     * If the transferables don't arrive within this window, the batch
     * fails with per-call error frames. Default: 1000.
     */
    sidecarTimeoutMs?: number;
  },
): SyncServerTransport {
  const dataSabSize = opts?.dataSabSize ?? DEFAULT_DATA_SAB_BYTES;
  const configuredClientId = opts?.clientId;
  const onClientDead = opts?.onClientDead;
  const sidecarTimeoutMs = opts?.sidecarTimeoutMs ?? 1000;

  // SAB pair + views. Allocated lazily on first `hs-req`; reused on
  // subsequent re-handshakes (see jsdoc above).
  let control: SharedArrayBuffer | null = null;
  let data: SharedArrayBuffer | null = null;
  let controlView: Int32Array | null = null;
  let dataU8: Uint8Array | null = null;

  // The one and only in-flight batch. Non-null from the doorbell
  // that completes the request envelope until the final response
  // chunk is acknowledged via `pull`. See BatchContext jsdoc.
  let activeBatch: BatchContext | null = null;

  // Multi-chunk request reassembly buffer. Filled across MORE_REQ
  // doorbells, drained when the caller writes DONE.
  let requestAccumulator: Uint8Array | null = null;

  // Sidecar MessagePort for transferable ownership. The host keeps
  // port1 and starts it; port2 is transferred to the caller in
  // the hs-res envelope. Allocated at handshake time; closed on
  // client death or rehandshake.
  let sidecarPort: MessagePort | null = null;

  // Sidecar receive buffer. Incoming transferable values are keyed
  // by (batchSeq, id) so the host can reconstruct wire envelopes
  // that contain @T:'transfer' sentinels. The buffer is populated
  // by the sidecar onmessage handler and consumed during doorbell
  // processing. Entries are cleared after dispatch to free
  // references. Bounded to MAX_BUFFERED_BATCHES recent batches;
  // oldest evict on overflow.
  const MAX_BUFFERED_BATCHES = 16;
  const sidecarBuffer = new Map<number, Map<number, unknown>>();
  // Per-batch resolvers: when the doorbell handler awaits missing
  // transferables, it registers a resolver keyed by batchSeq.
  // The sidecar onmessage fires the resolver when all expected
  // ids for that batch are buffered.
  const sidecarResolvers = new Map<
    number,
    {expected: Set<number>; resolve: () => void}
  >();

  // The single callback `rpc.addClient` registers via the wrapper's
  // `onMessage`. Non-sync inbound traffic and synthesized inbound calls
  // both flow through this.
  let rpcOnMessage:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;

  // Monotonic synth id for inbound sync calls. Starts well above any
  // realistic client `nextId` flow so collision with the host RPC's
  // own id space is impossible.
  let nextSynthId = 1_000_000;

  // ── Epoch tracking ────────────────────────────────────────────────────

  // Monotonic epoch counter. Incremented on each handshake; returned
  // in `hs-res` and validated on incoming `client_dead` notifications.
  // Epoch 0 is reserved for pre-handshake deaths (always rejected).
  let nextEpoch = 1;
  let currentEpoch = 0;

  // ── Client-dead dedup ─────────────────────────────────────────────────

  // Set of clientIds already processed for death. Prevents duplicate
  // `onClientDead` invocations when both the SAB poll and the
  // postMessage notification fire for the same worker.
  const deadClients = new Set<string>();

  // ── Drain-barrier bookkeeping ─────────────────────────────────────────

  // Per-client replay log. Instantiated at handshake time. Holds
  // idle-path outbound frames for replay into the next sync call's
  // response timeline.
  let replayLog: ReplayLog | null = null;

  // Monotonic host→client frame counter. Incremented on every idle-path
  // outbound frame and published to `CTRL.SERVER_OUT_SEQ` so the caller
  // can checkpoint what it has applied.
  let serverOutSeq = 0;

  // ── Inbound dispatch ───────────────────────────────────────────────────

  transport.onMessage(async (msg, ctx) => {
    if (isSyncControl(msg)) {
      if (msg.__sync === 'hs-req') {
        handleHandshake();
        return;
      }
      if (msg.__sync === 'doorbell') {
        await handleDoorbell(msg.seq);
        return;
      }
      if (msg.__sync === 'pull') {
        writeNextResponseChunk(msg.seq);
        return;
      }
      if (msg.__sync === 'client_dead') {
        handleClientDead(msg);
        return;
      }
      return; // unknown sync-control type — ignore
    }
    // Normal `WireMessage` from the caller (async path). Forward to RPC
    // if the host has wired up its callback; silently drop otherwise.
    // The drop case is unreachable in normal usage: `rpc.addClient` is
    // called synchronously after `enableSyncServer` returns, and the
    // base transport's inbound traffic cannot precede those calls in
    // the same tick.
    rpcOnMessage?.(msg, ctx);
  });

  // ── Handshake ──────────────────────────────────────────────────────────

  function handleHandshake(): void {
    // Reuse the existing SAB pair on re-handshake — the worker may
    // still be holding references to the originals. Allocate fresh
    // only on the first request.
    if (control === null || data === null) {
      const lane = allocateLane(dataSabSize);
      control = lane.control;
      data = lane.data;
      controlView = new Int32Array(control);
      dataU8 = new Uint8Array(data);
    }
    // Abort any in-flight batch from a prior connection. A rehandshake
    // mid-batch is a protocol violation by the caller, but resetting
    // defensively keeps the wrapper in a clean state — the suspended
    // `serviceSyncRequest` frame returns without publishing, and the
    // batch's closures become reclaimable.
    abortActiveBatch();
    requestAccumulator = null;

    // Close any prior sidecar port and clear pending sidecar state.
    // A rehandshake means the caller has a fresh client; the old
    // sidecar channel is dead. Using closeSidecarPort() instead of
    // inline close ensures sidecarResolvers and sidecarBuffer are
    // cleared — preventing seq-collision with the new client's
    // reset nextSeq=1 id space.
    closeSidecarPort();

    // Create a fresh sidecar channel for transferable ownership.
    // The host keeps port1; port2 is embedded in the hs-res envelope
    // and listed in ctx.transfer so postMessage transfers (not clones)
    // it. If the transport doesn't support transfer lists, the try/catch
    // below falls back to hs-res without the sidecar field.
    const sidecarChannel = new MessageChannel();
    sidecarPort = sidecarChannel.port1;
    sidecarPort.start();

    // Wire the sidecar receive listener. Populates the buffer with
    // incoming {seq, id, value} messages; fires any pending resolver
    // when the last expected id for a batch arrives.
    sidecarPort.onmessage = (event: MessageEvent) => {
      const msg = event.data as SidecarMessage;
      if (
        !msg ||
        typeof msg.seq !== 'number' ||
        typeof msg.id !== 'number'
      ) {
        return; // Malformed sidecar message — ignore.
      }
      let batchBuf = sidecarBuffer.get(msg.seq);
      if (!batchBuf) {
        batchBuf = new Map<number, unknown>();
        sidecarBuffer.set(msg.seq, batchBuf);
        // Evict oldest batches if the buffer exceeds the bound.
        if (sidecarBuffer.size > MAX_BUFFERED_BATCHES) {
          const oldest = sidecarBuffer.keys().next().value;
          if (oldest !== undefined) {
            sidecarBuffer.delete(oldest);
            sidecarResolvers.delete(oldest);
          }
        }
      }
      batchBuf.set(msg.id, msg.value);

      // Check if a pending resolver is satisfied.
      const pending = sidecarResolvers.get(msg.seq);
      if (pending) {
        let allPresent = true;
        for (const id of pending.expected) {
          if (!batchBuf.has(id)) {
            allPresent = false;
            break;
          }
        }
        if (allPresent) {
          sidecarResolvers.delete(msg.seq);
          pending.resolve();
        }
      }
    };

    // Reset lifecycle state from any prior death on this wrapper.
    // Without this, a wrapper that has processed a death permanently
    // drops all future doorbells (CALLER_STATE stays DEAD) and
    // silently ignores future deaths for the same clientId.
    if (controlView !== null) {
      storeCtrl(controlView, CTRL.CALLER_STATE, CALLER_STATE.ALIVE);
    }
    deadClients.clear();

    // Allocate a fresh epoch for this handshake. The epoch is
    // monotonic per wrapper instance; a stale `client_dead` from
    // a prior bridge (HMR recycle) carries the old epoch and is
    // rejected by `handleClientDead`.
    currentEpoch = nextEpoch++;

    // Initialize drain-barrier state on first handshake. On re-handshake
    // with a reused SAB, preserve serverOutSeq so the monotonic invariant
    // holds — rewinding would permanently disable the drain barrier
    // because the worker's max-guard on CLIENT_APPLIED_SEQ refuses to
    // lower its watermark.
    if (replayLog === null) {
      replayLog = new ReplayLog();
      // serverOutSeq stays at 0 from initialization.
    } else {
      // Re-handshake: fresh log, but serverOutSeq continues monotonically.
      replayLog = new ReplayLog();
    }
    // Send hs-res with the sidecar port. The port MUST appear in
    // both the message data AND the ctx.transfer list: Node
    // worker_threads delivers transferred ports as properties of the
    // message, while the transfer list tells postMessage to transfer
    // (not clone) them.
    //
    // If the transport can't handle transfer lists (e.g., test stubs,
    // the fake worker's postMessage that silently accepts anything),
    // we fall back to sending hs-res without the sidecar. The client
    // proceeds without sidecar and transferable values won't
    // round-trip.
    const hsRes = {
      __sync: 'hs-res' as const,
      control,
      data,
      epoch: currentEpoch,
      sidecar: sidecarChannel.port2,
    };
    try {
      transport.send(hsRes, {transfer: [sidecarChannel.port2]});
    } catch (_) {
      // Transport doesn't support transfer lists (DOMException:
      // "found in message but not listed in transferList"). Close
      // the host-side port since sidecar is unavailable, then
      // re-send hs-res without the sidecar field. The client will
      // proceed without sidecar and fail fast if transferable
      // values are later passed to rpc.wait.
      closeSidecarPort();
      transport.send({
        __sync: 'hs-res',
        control,
        data,
        epoch: currentEpoch,
      } satisfies SyncControl);
    }
  }

  // ── Client-dead handler ──────────────────────────────────────────────

  function handleClientDead(msg: {epoch: number; clientId: string}): void {
    const {epoch, clientId} = msg;
    // Reject malformed clientId.
    if (!clientId || typeof clientId !== 'string') return;
    // Reject pre-handshake deaths (epoch 0) — no lane state to clean.
    if (epoch === 0) return;
    // Reject stale epoch (HMR: old bridge's notification after new
    // bridge handshaked). Only the current epoch is valid.
    if (epoch !== currentEpoch) return;
    // Dedup: both the SAB poll and the postMessage
    // notification can fire for the same worker.
    if (deadClients.has(clientId)) return;
    deadClients.add(clientId);
    // Defensively assert CALLER_STATE.DEAD in the SAB. The detection
    // site's markCallerDead should have done this already, but its
    // SAB store is wrapped in a swallow-catch. If that store threw,
    // the SAB still reads ALIVE and queued doorbells would pass the
    // gate. Belt-and-suspenders — idempotent, ~3ns.
    if (controlView !== null) {
      storeCtrl(controlView, CTRL.CALLER_STATE, CALLER_STATE.DEAD);
    }
    // Abort any in-flight batch for this worker.
    abortActiveBatch();
    // Close the sidecar port — the client is gone, nobody will
    // post transferables on the other end.
    closeSidecarPort();
    // Invoke user callback (typically wired to rpc.removeClient).
    if (onClientDead) {
      try {
        onClientDead(clientId);
      } catch (err) {
        // User callback threw — swallow. The teardown is
        // best-effort from the wrapper's perspective.
        // eslint-disable-next-line no-console
        console.warn('[mixed-signals/sync] onClientDead callback threw', err);
      }
    }
  }

  /**
   * Notify client death from the SAB poll path. Uses
   * the same dedup set as `handleClientDead` so only one
   * `onClientDead` fires per worker.
   *
   * @internal
   */
  function closeSidecarPort(): void {
    if (sidecarPort !== null) {
      try {
        sidecarPort.close();
      } catch (_) {
        /* port may already be closed */
      }
      sidecarPort = null;
    }
    // Clear any pending sidecar state.
    sidecarBuffer.clear();
    // Resolve any pending waiters so they don't hang.
    for (const pending of sidecarResolvers.values()) {
      pending.resolve();
    }
    sidecarResolvers.clear();
  }

  function notifyClientDeadFromPoll(clientId: string): void {
    if (!clientId || deadClients.has(clientId)) return;
    deadClients.add(clientId);
    abortActiveBatch();
    closeSidecarPort();
    if (onClientDead) {
      try {
        onClientDead(clientId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mixed-signals/sync] onClientDead callback threw (poll path)', err);
      }
    }
  }

  function abortActiveBatch(): void {
    if (activeBatch === null) return;
    activeBatch.aborted = true;
    activeBatch.resolve();
    activeBatch = null;
    // Clear the SAB interception flag so post-abort frames route
    // through the idle path. Must happen here (not in the post-await
    // branch) to avoid a race where batch B sets the flag and then
    // batch A's cleanup clobbers it back to 0.
    if (controlView !== null) {
      storeCtrl(controlView, CTRL.ACTIVE_SYNC_SEQ, 0);
    }
  }

  // ── Doorbell (per-chunk request) ───────────────────────────────────────

  /**
   * One doorbell per request chunk. Reads the current chunk from the
   * data SAB, appends to the accumulator, then either:
   *
   *   - acks (`CHUNK_STATE = ACK_REQ` + `Atomics.notify`) so the caller
   *     can write the next chunk, or
   *   - finalizes (the caller wrote `CHUNK_STATE = DONE`): parses the
   *     assembled envelope and dispatches via `serviceSyncRequest`.
   *
   * The host cannot `Atomics.wait` on the main thread, so the caller
   * drives flow control by sending one doorbell per chunk. This handler
   * runs exactly once per doorbell.
   */
  async function handleDoorbell(seq: number): Promise<void> {
    if (controlView === null || dataU8 === null) {
      // Doorbell before handshake — protocol violation by caller.
      // Silently ignore; the caller's wait will time out.
      return;
    }
    if (loadCtrl(controlView, CTRL.CALLER_STATE) === CALLER_STATE.DEAD) {
      // Lifecycle owner has signalled the caller is gone.
      // Drop the request silently; do not write a response that nobody
      // will read.
      return;
    }

    const bytesValid = loadCtrl(controlView, CTRL.CHUNK_BYTES_VALID);
    const chunkState = loadCtrl(controlView, CTRL.CHUNK_STATE);

    // Copy out of the SAB-backed view before any decode pass.
    // `TextDecoder.decode()` rejects shared views in browsers.
    // `Uint8Array.prototype.slice` allocates a fresh non-shared buffer.
    const chunk = dataU8.slice(0, bytesValid);

    const accumulator = requestAccumulator ?? new Uint8Array(0);
    const combined = new Uint8Array(
      accumulator.byteLength + chunk.byteLength,
    );
    combined.set(accumulator, 0);
    combined.set(chunk, accumulator.byteLength);
    requestAccumulator = combined;

    if (chunkState === CHUNK_STATE.MORE_REQ) {
      // Ack so the caller can write the next chunk.
      storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.ACK_REQ);
      Atomics.notify(controlView, CTRL.CHUNK_STATE);
      return;
    }

    // `CHUNK_STATE.DONE` — this was the final request chunk. Take
    // ownership of the accumulator and clear it so the wrapper is
    // ready for the next batch.
    const fullPayload = requestAccumulator;
    requestAccumulator = null;

    // A new batch is starting. If a prior batch is still in flight
    // (the caller threw on timeout and is retrying), abort it: the
    // suspended `serviceSyncRequest` frame will see `aborted = true`
    // after its `await` and return without publishing a response the
    // caller no longer reads. This is the structural fix for the
    // host-side suspended-frame leak that previously occurred when
    // per-batch state lived in module-scope vars.
    if (activeBatch !== null) abortActiveBatch();

    await serviceSyncRequest(seq, fullPayload);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

  async function serviceSyncRequest(
    seq: number,
    fullPayload: Uint8Array,
  ): Promise<void> {
    if (controlView === null || dataU8 === null) return;

    const requestJson = new TextDecoder().decode(fullPayload);
    const envelope = JSON.parse(requestJson) as {
      seq: number;
      clientAppliedSeq?: number;
      calls: Array<{method: string; params?: unknown[]}>;
    };
    const calls = envelope.calls;

    // Read the caller's applied-seq watermark. Defaults to
    // 0 for clients that don't send it yet.
    const clientAppliedSeq = envelope.clientAppliedSeq ?? 0;

    // Build a fresh BatchContext for this batch. `done` resolves when
    // every expected response is captured OR when the batch is aborted
    // by a follow-on doorbell or rehandshake.
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const batch: BatchContext = {
      seq,
      orderedIds: [],
      expected: new Set<number>(),
      captured: new Map<number, WireMessage>(),
      timeline: [],
      done,
      resolve: resolveDone,
      aborted: false,
      timelineFrozen: false,
      responseQueue: null,
    };
    activeBatch = batch;

    // ── Snapshot replay frames BEFORE dispatch (design §4 step 6) ─────
    // Frames emitted during dispatch must NOT appear in the replay
    // slice — they route through the active-batch capture path instead.
    // Snapshotting before dispatch ensures clean separation.
    let replaySnapshotWithSeqs: ReadonlyArray<{
      seq: number;
      msg: WireMessage;
    }> = [];
    let replayedUpToSeq = clientAppliedSeq;
    if (replayLog !== null) {
      const {frames, gap} = replayLog.framesAfter(clientAppliedSeq);
      if (gap) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mixed-signals/sync] replay-log gap: clientAppliedSeq=${clientAppliedSeq}, ` +
            `oldestSeq=${replayLog.oldestSeq()}, serverOutSeq=${serverOutSeq}. ` +
            'Some frames were evicted before replay.',
        );
      }
      replaySnapshotWithSeqs = frames;
    }

    // Publish ACTIVE_SYNC_SEQ so cross-context observers (future §6.2
    // broker) can see the active-sync state on the SAB.
    storeCtrl(controlView, CTRL.ACTIVE_SYNC_SEQ, seq);

    // ── Sidecar transferable reconstruction ──────────────────────────
    // Scan the parsed calls for @T:'transfer' sentinels. If any are
    // found, wait for the matching transferable values to arrive on
    // the sidecar (or find them already buffered), then reconstruct
    // the calls by swapping sentinels for actual values.
    let skipDispatch = false;
    const expectedIds = collectExpectedTransferIds(calls);
    if (expectedIds.size > 0) {
      const batchBuf = sidecarBuffer.get(seq) ?? new Map<number, unknown>();
      if (!sidecarBuffer.has(seq)) sidecarBuffer.set(seq, batchBuf);

      // Check if all expected transferables are already buffered.
      let allPresent = true;
      for (const id of expectedIds) {
        if (!batchBuf.has(id)) {
          allPresent = false;
          break;
        }
      }

      if (!allPresent) {
        // Await remaining transferables with a timeout.
        // Use the configurable timeout from enableSyncServer opts.
        const sidecarDone = await Promise.race([
          new Promise<'ok'>((resolve) => {
            sidecarResolvers.set(seq, {
              expected: expectedIds,
              resolve: () => resolve('ok'),
            });
          }),
          new Promise<'timeout'>((resolve) => {
            const timer = setTimeout(
              () => resolve('timeout'),
              sidecarTimeoutMs,
            );
            (timer as unknown as {unref?: () => void}).unref?.();
          }),
        ]);
        sidecarResolvers.delete(seq);

        if (batch.aborted) {
          sidecarBuffer.delete(seq);
          return;
        }
        if (sidecarDone === 'timeout') {
          // Timeout: pre-populate error frames for all calls so the
          // normal response composition path below emits them.
          skipDispatch = true;
          for (const call of calls) {
            const synthId = nextSynthId++;
            batch.orderedIds.push(synthId);
            batch.expected.add(synthId);
            batch.captured.set(synthId, {
              type: 'error',
              id: synthId,
              value: {
                message:
                  `Sidecar transferable timeout: expected ${expectedIds.size} ` +
                  `transferables for batch seq=${seq}, received ${batchBuf.size}`,
                name: 'SyncRPCError',
              },
            });
          }
          resolveDone();
          sidecarBuffer.delete(seq);
        }
      }

      if (!skipDispatch) {
        // Reconstruct: replace sentinels with actual values.
        const finalBuf = sidecarBuffer.get(seq)!;
        const reconstructed = reconstructTransferables(calls, finalBuf);
        // Overwrite calls in-place for the dispatch below.
        for (let i = 0; i < calls.length; i++) {
          calls[i] = reconstructed[i]!;
        }
        // Clean up the buffer entry — values are now owned by the
        // dispatch path.
        sidecarBuffer.delete(seq);
      }
    }

    if (!skipDispatch) {
      // Pre-allocate every synth id BEFORE dispatching any call.
      const synthesizedCalls: WireMessage[] = [];
      for (const call of calls) {
        const synthId = nextSynthId++;
        batch.orderedIds.push(synthId);
        batch.expected.add(synthId);
        synthesizedCalls.push({
          type: 'call',
          id: synthId,
          method: call.method,
          params: call.params ?? [],
        });
      }
      const expectedTotal = batch.expected.size;

      // Dispatch.
      for (const synthesized of synthesizedCalls) {
        rpcOnMessage?.(synthesized);
      }

      // Empty batch: nothing to wait for.
      if (expectedTotal === 0) {
        resolveDone();
      }
    }

    await done;

    // If aborted while suspended, the caller has moved on.
    // ACTIVE_SYNC_SEQ was already cleared by abortActiveBatch.
    if (batch.aborted) return;

    // ── Compose response timeline ──────────────────────────────────
    // Order: replayed frames (snapshot) → side-effects → results.
    const timeline: WireMessage[] = [];

    // 1. Replayed frames from pre-dispatch snapshot. Only replay
    //    notification frames — result/error frames from prior async
    //    calls belong to a different call's lifecycle and must not
    //    be mixed into this batch's positional result matching.
    //    Track the highest replayed seq so the response watermark
    //    only covers frames the worker will actually process.
    let highestReplayedSeq = clientAppliedSeq;
    for (let i = 0; i < replaySnapshotWithSeqs.length; i++) {
      const entry = replaySnapshotWithSeqs[i]!;
      if (entry.msg.type === 'notification') {
        timeline.push(entry.msg);
        if (entry.seq > highestReplayedSeq) {
          highestReplayedSeq = entry.seq;
        }
      }
    }
    replayedUpToSeq = highestReplayedSeq;

    // 2. Side-effect notifications captured during dispatch.
    for (const notif of batch.timeline) {
      timeline.push(notif);
    }

    // 3. Results in caller-input order. Each result value is scanned
    //    for Transferable instances; if any are found, the result
    //    frame is replaced with an error frame carrying
    //    SyncRPCResponseTransferableError. This is the loud-failure
    //    guardrail that prevents silent JSON corruption of
    //    transferable returns (ArrayBuffer → `{}`). Response-side
    //    transferable transfer is deferred to a future milestone.
    for (const id of batch.orderedIds) {
      let frame: WireMessage =
        batch.captured.get(id) ?? {
          type: 'error',
          id,
          value: {message: `no response captured for synth id ${id}`},
        };

      // Guardrail: scan result values for Transferable instances.
      if (frame.type === 'result') {
        const found = findTransferableInValue(frame.value);
        if (found) {
          const err = new SyncRPCResponseTransferableError(
            'Response-side Transferable values are not yet supported in sync RPC. ' +
              'This is a planned capability (deferred to a future milestone). ' +
              `Found: ${found.type} at ${found.path}.`,
          );
          frame = {
            type: 'error',
            id,
            value: {message: err.message, name: err.name},
          };
        }
      }

      timeline.push(frame);
    }

    // Freeze the timeline: after this point, new notifications must
    // route through the idle path, not batch.timeline.
    batch.timelineFrozen = true;

    // Evict confirmed frames from the replay log.
    if (replayLog !== null) {
      replayLog.dropUpTo(clientAppliedSeq);
    }

    const responseJson = JSON.stringify({seq, replayedUpToSeq, timeline});
    const encoded = new TextEncoder().encode(responseJson);

    // Publish RESPONSE_SEQ — informational. The caller's wake signal
    // is `CHUNK_STATE = DONE_RES` on the final chunk; bumping
    // RESPONSE_SEQ here is for debuggability (the drain barrier
    // expects this slot to track per-batch completion).
    storeCtrl(controlView, CTRL.RESPONSE_SEQ, seq);

    batch.responseQueue = {bytes: encoded, offset: 0};
    // `activeBatch` is intentionally NOT cleared yet — subsequent
    // `pull` doorbells from the caller still need to find this batch
    // to write follow-on chunks. The slot is cleared by
    // `writeNextResponseChunk` after the final chunk lands.
    writeNextResponseChunk();
  }

  // ── Pull (per-chunk response) ──────────────────────────────────────────

  /**
   * Writes the next pending response chunk into the data SAB and
   * notifies the caller via `Atomics.notify` on `CHUNK_STATE`. Called
   * once eagerly after dispatch (first chunk), then again on each
   * `{__sync: 'pull', seq}` doorbell from the caller.
   *
   * `CHUNK_STATE = MORE_RES` for non-final chunks; `DONE_RES` for the
   * final chunk. `DONE_RES` is distinct from `DONE` (the idle / final
   * *request* state) so the caller's `Atomics.wait` on `CHUNK_STATE`
   * sees a transition even for single-chunk responses — without that
   * distinct state, a `DONE → DONE` non-transition would stall the
   * wake.
   */
  function writeNextResponseChunk(seq?: number): void {
    if (
      controlView === null ||
      dataU8 === null ||
      activeBatch === null ||
      activeBatch.responseQueue === null
    ) {
      return;
    }
    // ── CALLER_STATE poll ────────────────────────────────────────────
    // Before writing each response chunk, check whether the caller is
    // dead. Cost: ~3-5 ns per chunk (one Atomics.load). If dead, abort
    // the response — nobody will read it.
    if (loadCtrl(controlView, CTRL.CALLER_STATE) === CALLER_STATE.DEAD) {
      if (configuredClientId) {
        notifyClientDeadFromPoll(configuredClientId);
      }
      return;
    }
    // Gate by seq when a pull-driven call supplies one. If the pull
    // is for an aborted prior batch, `seq` won't match `activeBatch.seq`
    // — silently drop. Without this, a postMessage-FIFO race could
    // let a stale pull-A overwrite caller-just-written batch-B request
    // bytes in the data SAB before the new doorbell handler reads
    // them, corrupting batch-B's envelope and crashing the wrapper.
    if (seq !== undefined && seq !== activeBatch.seq) return;
    const queue = activeBatch.responseQueue;
    const remaining = queue.bytes.byteLength - queue.offset;
    const thisChunkSize = Math.min(remaining, dataU8.byteLength);
    const isLast = queue.offset + thisChunkSize === queue.bytes.byteLength;

    dataU8.set(
      queue.bytes.subarray(queue.offset, queue.offset + thisChunkSize),
      0,
    );
    storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, thisChunkSize);
    storeCtrl(
      controlView,
      CTRL.CHUNK_STATE,
      isLast ? CHUNK_STATE.DONE_RES : CHUNK_STATE.MORE_RES,
    );
    Atomics.notify(controlView, CTRL.CHUNK_STATE);

    if (isLast) {
      // Batch fully delivered. Clear ACTIVE_SYNC_SEQ and release the
      // slot so the next doorbell can install a fresh BatchContext;
      // post-publish notifications route via the idle/async path.
      storeCtrl(controlView, CTRL.ACTIVE_SYNC_SEQ, 0);
      activeBatch = null;
    } else {
      activeBatch.responseQueue = {
        bytes: queue.bytes,
        offset: queue.offset + thisChunkSize,
      };
    }
  }

  // ── Wrapped transport ──────────────────────────────────────────────────

  const wrapper: RawTransport = {
    mode: 'raw',
    send(payload, ctx) {
      // Route outbound frames by sync state:
      //   - Active sync batch: capture result/error for the batch; capture
      //     notification side-effects into the timeline.
      //   - Idle (no active batch): wrap in `{__sync: 'frame', seq, msg}`
      //     envelope for drain-barrier bookkeeping, or pass through if
      //     the handshake hasn't happened yet.
      const batch = activeBatch;
      if (batch !== null && !batch.aborted) {
        const msg = payload as WireMessage;
        if (
          msg &&
          (msg.type === 'result' || msg.type === 'error') &&
          batch.expected.has(msg.id) &&
          !batch.captured.has(msg.id)
        ) {
          batch.captured.set(msg.id, msg);
          if (batch.captured.size === batch.expected.size) {
            batch.resolve();
          }
          return;
        }
        // Side-effect notifications emitted during the active sync
        // batch are captured into the timeline — but only while the
        // timeline is still open for capture. Once frozen (after
        // serialization), notifications must fall through to the
        // idle path so they enter the replay log and ship via the
        // next sync call.
        if (msg && msg.type === 'notification' && !batch.timelineFrozen) {
          batch.timeline.push(msg);
          return;
        }
      }

      // Idle-path emission: wrap outbound WireMessages with seq +
      // log to the replay log. Non-WireMessage control frames (like
      // hs-res) pass through unwrapped.
      const msg = payload as WireMessage;
      if (
        controlView !== null &&
        replayLog !== null &&
        msg &&
        typeof msg.type === 'string'
      ) {
        serverOutSeq++;
        // Publish to SAB BEFORE the log push — the SAB is the
        // authoritative source for serverOutSeq even if the log
        // push fails.
        storeCtrl(controlView, CTRL.SERVER_OUT_SEQ, serverOutSeq);
        replayLog.push(serverOutSeq, msg);
        const frame: SyncControl = {
          __sync: 'frame',
          seq: serverOutSeq,
          msg,
        };
        transport.send(frame, ctx);
        return;
      }

      transport.send(payload, ctx);
    },
    onMessage(cb) {
      rpcOnMessage = cb;
    },
    encode: transport.encode,
    decode: transport.decode,
    ready: transport.ready,
  };

  /**
   * Co-located lifecycle seam for Node `worker_threads` and other
   * topologies where the detection site and the server share a
   * process. Iframe bridges reach `handleClientDead` via the
   * postMessage `client_dead` envelope; Node bridges call this
   * method directly to get the same abort + cleanup behavior.
   *
   * @internal — not part of the public RawTransport surface.
   */
  const syncWrapper = wrapper as SyncServerTransport;
  syncWrapper.markDead = (clientId: string) => {
    // Reuse the same path as handleClientDead but skip epoch
    // validation — the co-located lifecycle owner has direct
    // evidence (error/exit event), not a postMessage envelope.
    if (!clientId || typeof clientId !== 'string') return;
    if (deadClients.has(clientId)) return;
    deadClients.add(clientId);
    if (controlView !== null) {
      storeCtrl(controlView, CTRL.CALLER_STATE, CALLER_STATE.DEAD);
    }
    abortActiveBatch();
    closeSidecarPort();
    if (onClientDead) {
      try {
        onClientDead(clientId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mixed-signals/sync] onClientDead callback threw (markDead)', err);
      }
    }
  };

  return syncWrapper;
}

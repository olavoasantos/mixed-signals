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
import {ReplayLog} from './replay-log.ts';

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
    }
  | {__sync: 'doorbell'; seq: number}
  | {__sync: 'pull'; seq: number}
  | {__sync: 'frame'; seq: number; msg: WireMessage};

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
   * with results in the response timeline (M002I005T).
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
  opts?: {dataSabSize?: number},
): RawTransport {
  const dataSabSize = opts?.dataSabSize ?? DEFAULT_DATA_SAB_BYTES;

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

  // ── Drain-barrier bookkeeping (M002) ──────────────────────────────────

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
    transport.send({
      __sync: 'hs-res',
      control,
      data,
    } satisfies SyncControl);
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
      // Lifecycle owner has signalled the caller is gone (M003+).
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

    // M002I004T: read the caller's applied-seq watermark. Defaults to
    // 0 for pre-M002 clients that don't send it yet.
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
    let replaySnapshot: WireMessage[] = [];
    let replayedUpToSeq = serverOutSeq;
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
      replaySnapshot = frames.map((f) => f.msg);
    }

    // Publish ACTIVE_SYNC_SEQ so cross-context observers (future §6.2
    // broker) can see the active-sync state on the SAB.
    storeCtrl(controlView, CTRL.ACTIVE_SYNC_SEQ, seq);

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
    for (const msg of replaySnapshot) {
      if (msg.type === 'notification') {
        timeline.push(msg);
      }
    }

    // 2. Side-effect notifications captured during dispatch.
    for (const notif of batch.timeline) {
      timeline.push(notif);
    }

    // 3. Results in caller-input order.
    for (const id of batch.orderedIds) {
      const captured = batch.captured.get(id);
      timeline.push(
        captured ?? {
          type: 'error',
          id,
          value: {message: `no response captured for synth id ${id}`},
        },
      );
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
    // RESPONSE_SEQ here is for debuggability and M002+ (drain barrier
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

  return wrapper;
}

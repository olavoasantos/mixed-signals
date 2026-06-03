import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../shared/protocol.ts';
import {HANDLE_MARKER} from '../shared/protocol.ts';
import {SyncRPCError, SyncRPCIframeBridgeError, SyncRPCTimeoutError} from './errors.ts';
import {decodeHeader, WIRE_TYPE} from './header.ts';
import {CHUNK_STATE, CTRL, loadCtrl, storeCtrl} from './lane.ts';
import {
  collectAndReplaceSyncTransferables,
  type CollectedTransferable,
  type SidecarMessage,
} from './transferables.ts';

/**
 * Idle-path frame envelope emitted by `enableSyncServer`.
 * Distinguished from regular `WireMessage`s and other `SyncControl`
 * frames by `__sync: 'frame'`.
 *
 * @internal
 */
interface SyncFrame {
  __sync: 'frame';
  seq: number;
  msg: WireMessage;
}

function isSyncFrame(data: unknown): data is SyncFrame {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as {__sync?: unknown}).__sync === 'frame' &&
    typeof (data as {seq?: unknown}).seq === 'number' &&
    (data as {msg?: unknown}).msg !== null &&
    typeof (data as {msg?: unknown}).msg === 'object'
  );
}

/**
 * Out-of-band sync-transport control frames carried over the base
 * postMessage transport. Mirror of the server-side `SyncControl`.
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
  | {__sync: 'pull'; seq: number};

interface HandshakeRes {
  __sync: 'hs-res';
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
  epoch?: number;
  sidecar?: MessagePort;
}

function isHandshakeRes(data: unknown): data is HandshakeRes {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as {__sync?: unknown}).__sync === 'hs-res'
  );
}

/**
 * Caller-side: initiate the SAB handshake over `transport` and
 * resolve with a sync-capable `Transport` whose `wait?` method runs
 * the request/response chunk-state machine.
 *
 * Pass the result to `new RPCClient(...)`. The returned transport
 * proxies `send`, `onMessage`, `encode`, `decode`, and `ready` from
 * the base transport unchanged; only the `wait?` method is new.
 *
 * **Handshake protocol.** On invocation, posts `{__sync: 'hs-req'}`
 * to the base transport and awaits a matching `{__sync: 'hs-res',
 * control, data}` reply with both SABs. Rejects with
 * `SyncRPCTimeoutError` if no reply arrives within `opts.timeoutMs`
 * (default 5000 ms). Rejects with `SyncRPCIframeBridgeError` if the
 * `hs-res` payload's SAB fields aren't `SharedArrayBuffer` instances
 * — that condition indicates a topology misconfiguration (e.g., a
 * cross-origin iframe boundary the SAB transfer cannot cross; see
 * design §6.3).
 *
 * **Handshake message queue.** The host's `@R` root notification
 * commonly arrives *before* the `RPCClient` constructor (which
 * follows this function's resolution) gets a chance to subscribe via
 * `wrapper.onMessage(cb)`. Any non-handshake messages received in
 * the handshake window are buffered in arrival order and replayed
 * to the first `cb` the wrapper sees, preserving order across the
 * subscription boundary. After replay, the wrapper forwards inbound
 * traffic live.
 *
 * **`wait` semantics.** The returned transport's `wait?` method is
 * synchronous — it runs `Atomics.wait` to block the calling worker.
 * Browsers and Node both forbid `Atomics.wait` on the main thread,
 * so this method must only be called from a worker context. The
 * method accepts pre-encoded `WireMessage[]` and returns response
 * `WireMessage[]` in input order; brand substitution and hydration
 * are the consumer's responsibility (handled by `RPCClient.wait`).
 *
 * @throws SyncRPCTimeoutError — handshake didn't complete within
 *   `timeoutMs`, OR a subsequent `wait` call's `Atomics.wait` timed
 *   out (only when the `wait` caller supplied `timeoutMs`; there is
 *   no finite default per design §14).
 * @throws SyncRPCIframeBridgeError — handshake response carried
 *   malformed SAB fields.
 * @throws RangeError — `opts.timeoutMs` is not a positive finite
 *   number.
 */
export function enableSyncClient(
  transport: RawTransport,
  opts?: {timeoutMs?: number},
): Promise<RawTransport> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isInteger(timeoutMs)
  ) {
    return Promise.reject(
      new RangeError(
        `enableSyncClient: opts.timeoutMs must be a positive integer; got ${timeoutMs}`,
      ),
    );
  }

  // Per-instance state. Resolved once the handshake completes.
  let control!: SharedArrayBuffer;
  let data!: SharedArrayBuffer;
  let controlView!: Int32Array;
  let dataU8!: Uint8Array;

  // Sidecar MessagePort for transferable ownership. Received from
  // the host in the hs-res envelope. The caller stores and starts
  // it; posts transferable values here after the SAB doorbell.
  let sidecarPort: MessagePort | null = null;

  // Subscription routing. Until the consumer calls
  // `wrapper.onMessage(cb)`, inbound non-handshake messages are
  // buffered to preserve arrival order across the subscription
  // boundary — the host's `@R` root notification typically lands
  // before the `RPCClient` constructor subscribes.
  let rpcSubscriber:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;
  const pending: Array<{
    data: unknown;
    ctx: TransportContext | undefined;
    seq?: number;
  }> = [];

  let handshakeResolved = false;
  let handshakeResolve: (() => void) | undefined;
  let handshakeReject: ((err: unknown) => void) | undefined;

  transport.onMessage((msg, ctx) => {
    if (!handshakeResolved && isHandshakeRes(msg)) {
      if (
        !(msg.control instanceof SharedArrayBuffer) ||
        !(msg.data instanceof SharedArrayBuffer)
      ) {
        handshakeReject?.(
          new SyncRPCIframeBridgeError(
            'sync handshake response carried malformed SAB fields; ' +
              'verify the host wrapper and that the parent ↔ iframe ' +
              'boundary is same-origin (see design §6.3)',
          ),
        );
        return;
      }
      control = msg.control;
      data = msg.data;
      controlView = new Int32Array(control);
      dataU8 = new Uint8Array(data);
      // Store and start the sidecar port for transferable ownership.
      // Present when the transport propagates ctx.transfer; absent
      // when it doesn't (the server falls back to hs-res without
      // sidecar). The client proceeds without sidecar and
      // transferable sends are skipped.
      if (
        msg.sidecar &&
        typeof MessagePort !== 'undefined' &&
        msg.sidecar instanceof MessagePort
      ) {
        sidecarPort = msg.sidecar;
        sidecarPort.start();
      }

      handshakeResolved = true;
      handshakeResolve?.();
      return;
    }

    // Unwrap idle-path frame envelopes. The host wraps
    // every idle-path outbound frame as `{__sync: 'frame', seq, msg}`
    // so the worker can checkpoint which frames it has applied.
    if (isSyncFrame(msg)) {
      const inner = msg.msg;
      const seq = msg.seq;
      // Dedup: if the timeline replay already advanced CLIENT_APPLIED_SEQ
      // past this frame's seq, skip it — the worker has already applied
      // it via the response timeline.
      if (controlView !== null) {
        const current = loadCtrl(controlView, CTRL.CLIENT_APPLIED_SEQ);
        if (seq <= current) return;
      }
      // Deliver the inner WireMessage to the RPCClient.
      if (rpcSubscriber) {
        rpcSubscriber(inner, ctx);
        // Checkpoint AFTER delivery: any subsequent host read of
        // CLIENT_APPLIED_SEQ is guaranteed to be ≥ the seq of frames
        // the worker has finished applying.
        if (controlView !== null) {
          storeCtrl(controlView, CTRL.CLIENT_APPLIED_SEQ, seq);
        }
      } else {
        // Queued for later drain — don't checkpoint yet; the frame
        // hasn't been applied to the reactive layer.
        pending.push({data: inner, ctx, seq});
      }
      return;
    }

    // Non-handshake, non-frame inbound: route live to the RPCClient
    // if it has subscribed yet, otherwise buffer.
    if (rpcSubscriber) {
      rpcSubscriber(msg, ctx);
    } else {
      pending.push({data: msg, ctx});
    }
  });

  const handshakeReq: SyncControl = {__sync: 'hs-req'};
  transport.send(handshakeReq);

  const handshake = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
    const timer = setTimeout(() => {
      reject(
        new SyncRPCTimeoutError(
          `sync handshake timed out after ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
    // Don't keep the Node event loop alive solely for this timer;
    // browsers ignore `.unref` so this is a no-op there.
    (timer as unknown as {unref?: () => void}).unref?.();
  });

  let nextSeq = 1;

  function wait(
    calls: WireMessage[],
    waitOpts?: {timeoutMs?: number; flushPrelude?: () => WireMessage[]},
  ): WireMessage[] {
    if (waitOpts?.timeoutMs != null) {
      const t = waitOpts.timeoutMs;
      if (!Number.isFinite(t) || t <= 0 || !Number.isInteger(t)) {
        throw new RangeError(
          `rpc.wait: opts.timeoutMs must be a positive integer; got ${t}`,
        );
      }
    }

    const seq = nextSeq++;
    // Snapshot the caller's applied-seq watermark at
    // envelope-build time. The host uses this to determine which
    // replay-log frames to prepend to the response timeline.
    const clientAppliedSeq = loadCtrl(controlView, CTRL.CLIENT_APPLIED_SEQ);

    // ── Transferable substitution ────────────────────────────────────────
    // Walk the batch's call params and replace any Transferable values
    // (ArrayBuffer, MessagePort, etc.) with {@T:'transfer', id:N}
    // sentinels. The actual values are collected for sidecar emission
    // after the SAB doorbell. IDs are per-batch, monotonic from 1.
    const {calls: sentinelCalls, transferables: batchTransferables} =
      collectAndReplaceSyncTransferables(
        calls.filter(
          (c): c is {type: 'call'; id: number; method: string; params: unknown[]} =>
            c.type === 'call',
        ),
      );
    // Rebuild the full calls array with sentinel-substituted params.
    const finalCalls: WireMessage[] = calls.map((c) => {
      if (c.type !== 'call') return c;
      const replaced = sentinelCalls.find((sc) => sc.id === c.id);
      return replaced ? {...c, params: replaced.params} : c;
    });

    // Fail fast if the batch contains transferables but the sidecar
    // port was not established at handshake time (transport doesn't
    // support transfer lists). Without this guard, sentinels go into
    // the SAB, no sidecar posts happen, and the host times out after
    // 1 s with a generic error — confusing and slow.
    if (batchTransferables.length > 0 && sidecarPort === null) {
      throw new SyncRPCIframeBridgeError(
        'sync call contains Transferable values but no sidecar channel ' +
          'was established during handshake. The base transport must ' +
          'propagate ctx.transfer in its send() method for transferable ' +
          'support. See the sync transport configuration guide.',
      );
    }

    // Flush the prelude AFTER all synchronous validation has passed
    // (timeoutMs, sidecar check above). This is the transactional
    // commit point: if validation threw, the batches haven't been
    // drained and their debounce timers are intact. From here on,
    // the prelude is committed and will reach the host.
    const prelude = waitOpts?.flushPrelude?.() ?? [];
    const envelope = {seq, clientAppliedSeq, prelude, calls: finalCalls};
    const requestJson = JSON.stringify(envelope);
    const encoded = new TextEncoder().encode(requestJson);
    const totalBytes = encoded.byteLength;
    const chunkBytes = dataU8.byteLength;

    // Single deadline shared across the request and response loops.
    // Computed once here so both legs of the round trip honour the
    // same wall-clock budget; previously the request loop ignored
    // the deadline entirely, so a host that stalled between MORE_REQ
    // chunks blocked the worker forever despite `timeoutMs`.
    const deadline =
      waitOpts?.timeoutMs == null ? null : Date.now() + waitOpts.timeoutMs;
    let chunkIndex = 0;

    // ── Request side ─────────────────────────────────────────────────────
    // `JSON.stringify({seq, calls})` always produces at least
    // `{"seq":N,"calls":[]}` — non-zero — so one iteration through
    // the do/while always fires, covering the empty-batch case.
    let offset = 0;
    do {
      const remaining = totalBytes - offset;
      const thisChunkSize = Math.min(remaining, chunkBytes);
      const isLast = offset + thisChunkSize === totalBytes;

      dataU8.set(encoded.subarray(offset, offset + thisChunkSize), 0);
      storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, thisChunkSize);
      storeCtrl(
        controlView,
        CTRL.CHUNK_STATE,
        isLast ? CHUNK_STATE.DONE : CHUNK_STATE.MORE_REQ,
      );
      if (offset === 0) {
        // First chunk: publish BATCH_SIZE + REQUEST_SEQ for the host
        // to read once. The host doesn't `Atomics.wait` on
        // REQUEST_SEQ (it can't from a main thread), but the notify
        // is kept for symmetry and future use (drain barrier in
        // the drain barrier may consume the SEQ slot).
        storeCtrl(controlView, CTRL.BATCH_SIZE, calls.length);
        storeCtrl(controlView, CTRL.REQUEST_SEQ, seq);
        Atomics.notify(controlView, CTRL.REQUEST_SEQ);
      }

      const doorbell: SyncControl = {__sync: 'doorbell', seq};
      transport.send(doorbell);

      offset += thisChunkSize;
      chunkIndex++;

      if (!isLast) {
        // Wait for the host to ack this chunk before writing the next.
        // Loop on exact target state to defend against spurious wakes
        // (`Atomics.wait` returning `'ok'` or `'not-equal'` without
        // CHUNK_STATE actually advancing). Deadline-bounded so a host
        // that stalls mid-request can't wedge the worker forever.
        while (true) {
          const cur = Atomics.load(controlView, CTRL.CHUNK_STATE);
          if (cur === CHUNK_STATE.ACK_REQ) break;
          const remainingMs =
            deadline == null
              ? Number.POSITIVE_INFINITY
              : deadline - Date.now();
          if (deadline != null && remainingMs <= 0) {
            throw new SyncRPCTimeoutError(
              `rpc.wait(seq=${seq}) timed out awaiting ACK_REQ at chunk ${chunkIndex} after ${waitOpts!.timeoutMs} ms`,
            );
          }
          const status = Atomics.wait(
            controlView,
            CTRL.CHUNK_STATE,
            cur,
            remainingMs,
          );
          if (status === 'timed-out') {
            throw new SyncRPCTimeoutError(
              `rpc.wait(seq=${seq}) timed out at chunk ${chunkIndex} (Atomics.wait status=timed-out)`,
            );
          }
          // 'ok' or 'not-equal' — re-read CHUNK_STATE and loop.
        }
      }
    } while (offset < totalBytes);

    // ── Sidecar transferable emission ───────────────────────────────────
    // After the SAB doorbell, post each collected transferable via
    // the sidecar MessagePort. Each post transfers ownership of the
    // value out of the caller's realm. Order: SAB first, then
    // sidecar in id-order. The host's receive path handles either
    // arrival order.
    if (batchTransferables.length > 0 && sidecarPort !== null) {
      for (const t of batchTransferables) {
        const msg: SidecarMessage = {seq, id: t.id, value: t.value};
        try {
          sidecarPort.postMessage(msg, [t.value]);
        } catch (err) {
          // The value was already detached or the post failed.
          // Surface as SyncRPCError from rpc.wait.
          const typeName = (t.value as {constructor?: {name?: string}})
            .constructor?.name ?? 'Transferable';
          throw new SyncRPCError(
            `Failed to transfer ${typeName} (id=${t.id}) via sidecar: ${
              (err as Error).message
            }`,
          );
        }
      }
    }

    // ── Response side ────────────────────────────────────────────────────
    chunkIndex = 0;
    let responseAccumulator = new Uint8Array(0);
    while (true) {
      const cs = Atomics.load(controlView, CTRL.CHUNK_STATE);

      if (cs === CHUNK_STATE.MORE_RES || cs === CHUNK_STATE.DONE_RES) {
        const bytesValid = Atomics.load(controlView, CTRL.CHUNK_BYTES_VALID);
        const chunk = dataU8.slice(0, bytesValid);
        const next = new Uint8Array(
          responseAccumulator.byteLength + chunk.byteLength,
        );
        next.set(responseAccumulator, 0);
        next.set(chunk, responseAccumulator.byteLength);
        responseAccumulator = next;
        chunkIndex++;

        if (cs === CHUNK_STATE.DONE_RES) break;

        // Intermediate chunk: ack and pull next.
        storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.ACK_RES);
        const pull: SyncControl = {__sync: 'pull', seq};
        transport.send(pull);
        continue;
      }

      // Deadline-bounded wait. `Date.now() - deadline` is monotonic
      // enough for the µs-to-ms granularity of a sync round-trip
      // timeout; jitter is dominated by the cross-origin postMessage
      // latency, not by clock skew.
      const remainingMs =
        deadline == null ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (deadline != null && remainingMs <= 0) {
        throw new SyncRPCTimeoutError(
          `rpc.wait(seq=${seq}) timed out after ${waitOpts!.timeoutMs} ms (chunk ${chunkIndex})`,
        );
      }
      const status = Atomics.wait(
        controlView,
        CTRL.CHUNK_STATE,
        cs,
        remainingMs,
      );
      if (status === 'timed-out') {
        throw new SyncRPCTimeoutError(
          `rpc.wait(seq=${seq}) timed out at chunk ${chunkIndex} (Atomics.wait status=timed-out)`,
        );
      }
      // 'ok' or 'not-equal' — re-read CHUNK_STATE and loop.
    }

    // ── Decode binary response ────────────────────────────────────
    const {replayedUpToSeq, timeline} =
      decodeResponseTimeline(responseAccumulator);

    // Advance CLIENT_APPLIED_SEQ to the replay watermark so the
    // host doesn't re-replay the same frames on the next wait, and
    // so the inbound SyncFrame dedup drops the queued postMessages
    // that carry the same frames.
    if (
      replayedUpToSeq != null &&
      replayedUpToSeq > 0 &&
      controlView !== null
    ) {
      const current = loadCtrl(controlView, CTRL.CLIENT_APPLIED_SEQ);
      if (replayedUpToSeq > current) {
        storeCtrl(
          controlView,
          CTRL.CLIENT_APPLIED_SEQ,
          replayedUpToSeq,
        );
      }
    }

    return timeline;
  }

  const wrapper: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      transport.send(data, ctx);
    },
    onMessage(cb) {
      rpcSubscriber = cb;
      // Drain any messages that arrived during the handshake window
      // so the RPCClient sees them in order. Subsequent traffic
      // routes live in the inbound handler above.
      if (pending.length > 0) {
        const drained = pending.splice(0);
        for (const item of drained) {
          cb(item.data, item.ctx);
          // Bump CLIENT_APPLIED_SEQ on drain for frames that carried
          // a seq (idle-path SyncFrame envelopes). We deferred the
          // checkpoint at enqueue time because the frame hadn't been
          // applied to the reactive layer yet.
          if (item.seq != null && controlView !== null) {
            const current = loadCtrl(controlView, CTRL.CLIENT_APPLIED_SEQ);
            if (item.seq > current) {
              storeCtrl(controlView, CTRL.CLIENT_APPLIED_SEQ, item.seq);
            }
          }
        }
      }
    },
    encode: transport.encode,
    decode: transport.decode,
    ready: transport.ready,
    wait,
  };

  return handshake.then(() => wrapper);
}

// ── Response timeline binary decoder ─────────────────────────────────────

const textDecoder = new TextDecoder();

/**
 * Decode a binary response buffer into the preamble fields and a
 * `WireMessage[]` timeline. The binary layout is:
 *
 *   [SEQ: Int32] [REPLAYED_UP_TO_SEQ: Int32] [COUNT: Int32] [records...]
 *
 * Each record is decoded via `decodeHeader`. TYPE-enum fast-path
 * records reconstruct `WireMessage` objects directly from header
 * fields — no `JSON.parse`. TYPE=JSON records fall through to
 * standard `JSON.parse`.
 *
 * Result frames from fast-path records get a synthetic `id` of 0
 * — the timeline dispatcher in RPCClient.wait correlates results
 * positionally, not by id.
 */
function decodeResponseTimeline(buf: Uint8Array): {
  seq: number;
  replayedUpToSeq: number;
  timeline: WireMessage[];
} {
  const PREAMBLE_SIZE = 12;
  if (buf.byteLength < PREAMBLE_SIZE) {
    throw new SyncRPCError(
      `decodeResponseTimeline: buffer too small (${buf.byteLength} bytes, need at least ${PREAMBLE_SIZE})`,
    );
  }

  // Copy to a non-shared buffer for DataView compatibility in
  // browsers that reject SAB-backed views in TextDecoder.
  const local = buf.slice(0);
  const preambleView = new DataView(local.buffer, local.byteOffset, PREAMBLE_SIZE);
  const seq = preambleView.getInt32(0, true);
  const replayedUpToSeq = preambleView.getInt32(4, true);
  const count = preambleView.getInt32(8, true);

  if (count < 0) {
    throw new SyncRPCError(
      `decodeResponseTimeline: negative record count ${count}. Possible wire protocol version mismatch.`,
    );
  }

  if (count === 0) {
    return {seq, replayedUpToSeq, timeline: []};
  }

  const timeline: WireMessage[] = [];
  let offset = PREAMBLE_SIZE;

  for (let i = 0; i < count; i++) {
    const header = decodeHeader(local, offset);
    offset += header.totalSize;

    switch (header.type) {
      case WIRE_TYPE.VOID:
        timeline.push({type: 'result', id: 0, value: undefined});
        break;

      case WIRE_TYPE.BOOL:
        timeline.push({
          type: 'result',
          id: 0,
          value: header.inlineVal === 1,
        });
        break;

      case WIRE_TYPE.F64:
        timeline.push({
          type: 'result',
          id: 0,
          value: header.inlineVal,
        });
        break;

      case WIRE_TYPE.HANDLE_ID: {
        // Kind prefix byte is in payload (LEN=1); numeric id in INLINE_VAL.
        if (header.bytes.length === 0) {
          throw new SyncRPCError(
            `decodeResponseTimeline: HANDLE_ID record at index ${i} missing kind byte. ` +
              'Possible wire protocol version mismatch.',
          );
        }
        const kind = String.fromCharCode(header.bytes[0]!);
        const marker = `${kind}${header.inlineVal}`;
        timeline.push({
          type: 'result',
          id: 0,
          value: {[HANDLE_MARKER]: marker},
        });
        break;
      }

      case WIRE_TYPE.JSON: {
        // JSON fallback: decode the full WireMessage from JSON bytes.
        const jsonStr = textDecoder.decode(header.bytes);
        const parsed = JSON.parse(jsonStr) as WireMessage;
        timeline.push(parsed);
        break;
      }

      default:
        throw new SyncRPCError(
          `decodeResponseTimeline: unknown TYPE=${header.type} at record ${i} ` +
            `(offset ${offset - header.totalSize}). Possible wire protocol version mismatch.`,
        );
    }
  }

  // Defensive: verify all bytes were consumed. Trailing junk
  // indicates a wire-format mismatch (e.g., version skew or
  // corrupted buffer).
  if (offset !== local.byteLength) {
    throw new SyncRPCError(
      `decodeResponseTimeline: ${local.byteLength - offset} trailing bytes after ${count} records. ` +
        'Possible wire protocol version mismatch.',
    );
  }

  return {seq, replayedUpToSeq, timeline};
}

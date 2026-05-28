import type {
  RawTransport,
  Transport,
  TransportContext,
  WireMessage,
} from '../shared/protocol.ts';
import {
  CTRL,
  CHUNK_STATE,
  CALLER_STATE,
  DEFAULT_DATA_SAB_BYTES,
  allocateLane,
  loadCtrl,
  storeCtrl,
} from './lane.ts';

/**
 * Inline handshake / doorbell message shapes that travel via the base
 * postMessage transport. They're not WireMessages — they're out-of-band
 * sync-transport control frames, distinguished by a reserved `__sync`
 * field on the envelope.
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

function isSyncControl(data: unknown): data is SyncControl {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as {__sync?: unknown}).__sync === 'string'
  );
}

/**
 * Options for the host-side sync transport.
 */
export interface CreateSyncTransportHostOptions {
  /** Base postMessage transport (Worker.postMessage-shaped). MUST be raw mode. */
  base: RawTransport;
  /** Bytes of data SAB to allocate. Default 64 KiB. */
  dataSabSize?: number;
}

/**
 * Host-side: wraps a base `RawTransport` and returns a Transport that
 * `rpc.addClient(...)` consumes. The wrapper:
 *
 *   1. Allocates control + data SABs on first `hs-req` from the caller
 *      and ships them back via the base transport's `send`.
 *   2. On each `doorbell`, reads the request envelope from the data SAB,
 *      synthesizes `call` WireMessages into the RPC (via its registered
 *      onMessage callback), captures the matching responses while
 *      `activeSyncSeq != 0`, and writes the response envelope back into
 *      the data SAB.
 *   3. Forwards all non-sync messages through unchanged.
 *
 * Prototype scope: single-chunk envelopes only (request and response must
 * fit in one data SAB). N-arity supported. No replay log; no
 * between-call frame routing for tier-1 signal updates (which means the
 * drain barrier is partial — sync calls don't yet replay signal deltas
 * that piled up between calls).
 */
export function createSyncTransportHost(
  opts: CreateSyncTransportHostOptions,
): Transport {
  const {base, dataSabSize = DEFAULT_DATA_SAB_BYTES} = opts;

  let control: SharedArrayBuffer | null = null;
  let data: SharedArrayBuffer | null = null;
  let controlView: Int32Array | null = null;
  let dataU8: Uint8Array | null = null;

  /** Routes a captured response (intercepted from RPC's wrapper.send) into the in-flight sync batch. */
  let activeSyncSeq = 0;
  let captureById: Map<number, WireMessage> | null = null;
  let captureExpected = 0;
  let onAllCaptured: (() => void) | null = null;

  /**
   * Multi-chunk request reassembly buffer. The caller may send the request
   * envelope in multiple chunks; each doorbell carries one chunk. We accumulate
   * across doorbells and dispatch once the caller signals `CHUNK_STATE = DONE`.
   * Single in-flight request only (no pipelining), so one buffer is enough.
   */
  let requestAccumulator: Uint8Array | null = null;

  /**
   * Pending response chunks queued for delivery. After the host dispatches
   * a sync batch, the assembled response bytes get split into chunks of
   * `dataU8.byteLength`. The first chunk goes out immediately; subsequent
   * chunks are sent in response to `pull` doorbells from the caller.
   */
  let responseQueue: {bytes: Uint8Array; offset: number} | null = null;

  /** Single onMessage callback registered by `rpc.addClient`. */
  let rpcOnMessage:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;

  /** Monotonically increasing wire id for synthesized inbound calls. */
  let nextSynthId = 1_000_000; // namespaced high to not collide with real client ids

  // Set up the base transport's inbound handler exactly once.
  base.onMessage(async (msg, ctx) => {
    if (isSyncControl(msg)) {
      if (msg.__sync === 'hs-req') {
        // Allocate and ship back.
        const lane = allocateLane(dataSabSize);
        control = lane.control;
        data = lane.data;
        controlView = new Int32Array(control);
        dataU8 = new Uint8Array(data);
        const response: SyncControl = {
          __sync: 'hs-res',
          control,
          data,
        };
        base.send(response);
        return;
      }
      if (msg.__sync === 'doorbell') {
        await handleDoorbell(msg.seq);
        return;
      }
      if (msg.__sync === 'pull') {
        writeNextResponseChunk();
        return;
      }
      return; // unknown sync-control type
    }
    // Non-sync — forward to RPC.
    rpcOnMessage?.(msg, ctx);
  });

  /**
   * Per-doorbell entry point. Reads one chunk of the request envelope,
   * appends to the accumulator, and either:
   *   - acks (`CHUNK_STATE.ACK_REQ` + `Atomics.notify`) so the caller can
   *     send the next chunk, or
   *   - finalizes (chunkState was `DONE`): parses the assembled envelope
   *     and dispatches via `serviceSyncRequest`.
   *
   * The host can't `Atomics.wait`, so the caller drives flow control by
   * sending one doorbell per chunk; this handler runs once per doorbell.
   */
  async function handleDoorbell(seq: number): Promise<void> {
    if (!controlView || !dataU8) {
      throw new Error('handleDoorbell before handshake');
    }
    if (loadCtrl(controlView, CTRL.CALLER_STATE) === CALLER_STATE.DEAD) {
      return;
    }

    // Read the current chunk. Copy out of the SharedArrayBuffer-backed view
    // — browsers reject `TextDecoder.decode()` on a shared view
    // ("The provided ArrayBufferView value must not be shared.").
    // `Uint8Array.prototype.slice` copies into a fresh ArrayBuffer.
    const bytesValid = loadCtrl(controlView, CTRL.CHUNK_BYTES_VALID);
    const chunkState = loadCtrl(controlView, CTRL.CHUNK_STATE);
    const chunk = dataU8.slice(0, bytesValid);

    if (!requestAccumulator) requestAccumulator = new Uint8Array(0);
    const combined = new Uint8Array(
      requestAccumulator.byteLength + chunk.byteLength,
    );
    combined.set(requestAccumulator, 0);
    combined.set(chunk, requestAccumulator.byteLength);
    requestAccumulator = combined;

    if (chunkState === CHUNK_STATE.MORE_REQ) {
      // Ack so the caller can write the next chunk.
      storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.ACK_REQ);
      Atomics.notify(controlView, CTRL.CHUNK_STATE);
      return;
    }

    // CHUNK_STATE.DONE — this was the final request chunk. Parse and dispatch.
    const fullPayload = requestAccumulator;
    requestAccumulator = null;
    await serviceSyncRequest(seq, fullPayload);
  }

  async function serviceSyncRequest(
    seq: number,
    fullPayload: Uint8Array,
  ): Promise<void> {
    if (!controlView || !dataU8) {
      throw new Error('serviceSyncRequest before handshake');
    }

    const requestJson = new TextDecoder().decode(fullPayload);
    const envelope = JSON.parse(requestJson) as {
      seq: number;
      calls: WireMessage[];
    };

    // Set up capture window.
    activeSyncSeq = seq;
    captureById = new Map();
    captureExpected = envelope.calls.length;
    const allDone = new Promise<void>((resolve) => {
      onAllCaptured = resolve;
    });

    // Map each call's incoming `id` to a synthesized server-side id so we
    // don't collide with real RPC ids. We track both sides.
    const orderedIds: number[] = [];
    for (const call of envelope.calls) {
      const synthId = nextSynthId++;
      orderedIds.push(synthId);
      // Pretend this call arrived from a real client.
      rpcOnMessage?.({
        type: 'call',
        id: synthId,
        method: call.method,
        params: (call as {params?: unknown[]}).params ?? [],
      } satisfies WireMessage);
    }

    // If no calls (empty batch), resolve immediately.
    if (captureExpected === 0) {
      onAllCaptured?.();
    }

    await allDone;

    // Build the response envelope in input order.
    const results = orderedIds.map((id) => captureById!.get(id)!);

    // Build the response payload, then ship it chunk-by-chunk via the
    // chunk-state machine. The first chunk goes out now; subsequent
    // chunks are driven by `pull` doorbells from the caller.
    const responseJson = JSON.stringify({seq, results});
    const encoded = new TextEncoder().encode(responseJson);

    // Clear capture state before publishing so any post-publish frames
    // route normally (e.g. signal updates emitted between sync calls).
    activeSyncSeq = 0;
    captureById = null;
    captureExpected = 0;
    onAllCaptured = null;

    // Publish RESPONSE_SEQ once (informational — the caller drives
    // completion off `CHUNK_STATE = DONE_RES`, but we set this for
    // debuggability and future use).
    storeCtrl(controlView, CTRL.RESPONSE_SEQ, seq);

    responseQueue = {bytes: encoded, offset: 0};
    writeNextResponseChunk();
  }

  /**
   * Write the next pending response chunk into the data SAB and signal
   * the caller via `Atomics.notify` on `CHUNK_STATE`. Called once after
   * dispatch finishes (first chunk), then again on each `pull` doorbell.
   *
   * State machine:
   *   - more chunks remain after this one     → `CHUNK_STATE.MORE_RES`
   *   - this chunk is the final one           → `CHUNK_STATE.DONE_RES`
   */
  function writeNextResponseChunk(): void {
    if (!controlView || !dataU8 || !responseQueue) return;
    const {bytes, offset} = responseQueue;
    const remaining = bytes.byteLength - offset;
    const thisChunkSize = Math.min(remaining, dataU8.byteLength);
    const isLast = offset + thisChunkSize === bytes.byteLength;

    dataU8.set(bytes.subarray(offset, offset + thisChunkSize), 0);
    storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, thisChunkSize);
    storeCtrl(
      controlView,
      CTRL.CHUNK_STATE,
      isLast ? CHUNK_STATE.DONE_RES : CHUNK_STATE.MORE_RES,
    );
    Atomics.notify(controlView, CTRL.CHUNK_STATE);

    if (isLast) {
      responseQueue = null;
    } else {
      responseQueue = {bytes, offset: offset + thisChunkSize};
    }
  }

  // Wrapped transport handed to `rpc.addClient`.
  const wrapper: RawTransport = {
    mode: 'raw',
    send(payload, ctx) {
      // Intercept responses that match in-flight sync batch.
      if (activeSyncSeq !== 0 && captureById) {
        const msg = payload as WireMessage;
        if (msg && (msg.type === 'result' || msg.type === 'error')) {
          captureById.set(msg.id, msg);
          if (captureById.size === captureExpected) {
            onAllCaptured?.();
          }
          return;
        }
      }
      base.send(payload, ctx);
    },
    onMessage(cb) {
      rpcOnMessage = cb;
    },
    encode: base.encode,
    decode: base.decode,
    ready: base.ready,
  };

  return wrapper;
}

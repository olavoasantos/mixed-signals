import type {
  RawTransport,
  Transport,
  TransportContext,
  WireMessage,
} from '../shared/protocol.ts';
import {
  CTRL,
  CHUNK_STATE,
  storeCtrl,
} from './lane.ts';
import {SyncRPCTimeoutError} from './errors.ts';

type SyncControl =
  | {__sync: 'hs-req'}
  | {
      __sync: 'hs-res';
      control: SharedArrayBuffer;
      data: SharedArrayBuffer;
    }
  | {__sync: 'doorbell'; seq: number}
  | {__sync: 'pull'; seq: number};

function isHandshakeRes(
  data: unknown,
): data is Extract<SyncControl, {__sync: 'hs-res'}> {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as {__sync?: unknown}).__sync === 'hs-res'
  );
}

export interface AcceptSyncTransportOptions {
  /** Base postMessage transport (worker_threads parentPort / Worker / MessagePort). MUST be raw mode. */
  base: RawTransport;
  /** How long to wait for the host to deliver SABs. Default 5000 ms. */
  timeoutMs?: number;
}

/**
 * Worker-side: send a handshake request via `base`, wait for the host to
 * ship SABs, then return a sync-capable Transport (the same `base` with a
 * `wait?` method bolted on). Async messages still flow via the base
 * transport's send/onMessage; sync requests go through `wait?`.
 *
 * Prototype scope: single-chunk only. Times out by default after 5s if
 * the host doesn't respond to the handshake; the `wait()` itself uses
 * the caller-supplied `timeoutMs` (no default — design §14 forbids one).
 */
export async function acceptSyncTransport(
  opts: AcceptSyncTransportOptions,
): Promise<Transport> {
  const {base, timeoutMs = 5000} = opts;

  // Receive the handshake response, then resolve.
  let control!: SharedArrayBuffer;
  let data!: SharedArrayBuffer;
  let controlView!: Int32Array;
  let dataU8!: Uint8Array;

  // We need to capture pass-through messages (those meant for the
  // RPCClient) WHILE we listen for the handshake response, because the
  // host typically sends the root `@R` notification BEFORE (or at least
  // close to) the `hs-res`. The RPCClient subscribes only after
  // `acceptSyncTransport` returns; anything that arrives before that
  // subscription would otherwise be dropped.
  //
  // Queue pass-through messages here; replay them when the wrapper's
  // `onMessage(cb)` is finally called.
  let rpcCallerHandler:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;
  const pending: Array<{data: unknown; ctx: TransportContext | undefined}> =
    [];
  let handshakeResolve: (() => void) | undefined;

  base.onMessage((msg, ctx) => {
    if (isHandshakeRes(msg)) {
      control = msg.control;
      data = msg.data;
      controlView = new Int32Array(control);
      dataU8 = new Uint8Array(data);
      handshakeResolve?.();
      return;
    }
    if (rpcCallerHandler) {
      rpcCallerHandler(msg, ctx);
    } else {
      pending.push({data: msg, ctx});
    }
  });

  // Kick off handshake.
  const handshakeReq: SyncControl = {__sync: 'hs-req'};
  base.send(handshakeReq);

  await new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    setTimeout(() => {
      reject(
        new SyncRPCTimeoutError(
          `sync handshake timed out after ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs).unref?.();
  });

  // Outbound sequence numbers for sync requests.
  let nextSeq = 1;

  function wait(
    calls: WireMessage[],
    waitOpts?: {timeoutMs?: number},
  ): WireMessage[] {
    const seq = nextSeq++;
    const envelope = {seq, calls};
    const requestJson = JSON.stringify(envelope);
    const encoded = new TextEncoder().encode(requestJson);
    const totalBytes = encoded.byteLength;
    const chunkBytes = dataU8.byteLength;

    // ---- Send request, chunked if necessary --------------------------------
    //
    // For each chunk:
    //   1. Write the chunk's bytes to the data SAB.
    //   2. Store CHUNK_BYTES_VALID and CHUNK_STATE (MORE_REQ or DONE).
    //   3. On the FIRST chunk, also publish BATCH_SIZE + REQUEST_SEQ so the
    //      host can read them once at the start of the request.
    //   4. Send a postMessage doorbell so the host's event loop wakes.
    //   5. If more chunks remain, `Atomics.wait` on CHUNK_STATE until the
    //      host acknowledges (sets ACK_REQ).
    //
    // The host can't `Atomics.wait` (main thread / browser restriction), so
    // wakeup goes via postMessage. The caller (a worker) drives flow control.
    let offset = 0;
    while (offset < totalBytes) {
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
        storeCtrl(controlView, CTRL.BATCH_SIZE, calls.length);
        // Publish seq last so a reader sees a fully-written first chunk.
        storeCtrl(controlView, CTRL.REQUEST_SEQ, seq);
        Atomics.notify(controlView, CTRL.REQUEST_SEQ);
      }

      const doorbell: SyncControl = {__sync: 'doorbell', seq};
      base.send(doorbell);

      offset += thisChunkSize;

      if (!isLast) {
        // Wait for the host to ack this chunk before writing the next one.
        // Loop to defend against spurious wakes.
        while (true) {
          const cur = Atomics.load(controlView, CTRL.CHUNK_STATE);
          if (cur === CHUNK_STATE.ACK_REQ) break;
          Atomics.wait(controlView, CTRL.CHUNK_STATE, cur);
        }
      }
    }

    // ---- Receive response, chunked if necessary --------------------------
    //
    // The host writes response chunks one at a time, signaling via
    // `CHUNK_STATE`:
    //   - `MORE_RES` — a non-final chunk is in the SAB; we read, ack, then
    //                  send a `pull` doorbell to request the next chunk.
    //   - `DONE_RES` — the final chunk is in the SAB; we read and decode.
    //
    // Loop on exact state to defend against spurious wakes. We use a
    // deadline-bounded `Atomics.wait` for timeout support.
    const deadline =
      waitOpts?.timeoutMs == null ? null : Date.now() + waitOpts.timeoutMs;
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

        if (cs === CHUNK_STATE.DONE_RES) break;

        // Intermediate chunk: ack and pull next.
        storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.ACK_RES);
        const pull: SyncControl = {__sync: 'pull', seq};
        base.send(pull);
        continue;
      }

      const remaining =
        deadline == null ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (deadline != null && remaining <= 0) {
        throw new SyncRPCTimeoutError(
          `rpc.wait(seq=${seq}) timed out after ${waitOpts!.timeoutMs} ms`,
        );
      }
      const status = Atomics.wait(
        controlView,
        CTRL.CHUNK_STATE,
        cs,
        remaining,
      );
      if (status === 'timed-out') {
        throw new SyncRPCTimeoutError(
          `rpc.wait(seq=${seq}) timed out (Atomics.wait status=timed-out)`,
        );
      }
      // 'ok' or 'not-equal' — re-read CHUNK_STATE.
    }

    const responseJson = new TextDecoder().decode(responseAccumulator);
    const response = JSON.parse(responseJson) as {
      seq: number;
      results: WireMessage[];
    };
    return response.results;
  }

  // Caller-side Transport mirrors the base, with `wait?` bolted on and
  // onMessage routed through our interceptor.
  const wrapper: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      base.send(data, ctx);
    },
    onMessage(cb) {
      rpcCallerHandler = cb;
      // Drain any messages that arrived during the handshake window so
      // the RPCClient sees them in order.
      if (pending.length > 0) {
        const drained = pending.splice(0);
        for (const item of drained) cb(item.data, item.ctx);
      }
    },
    encode: base.encode,
    decode: base.decode,
    ready: base.ready,
    wait,
  };

  return wrapper;
}

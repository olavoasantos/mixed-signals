/**
 * Two-SAB lane layout, per design §2.
 *
 * Control SAB: 256 bytes (cache-line-friendly Int32 header).
 * Data SAB: configurable, default 64 KiB.
 *
 * All offsets are in BYTES; convert to Int32 indices via `>> 2`.
 *
 * Prototype scope: we ship the full header layout (so we don't break wire
 * compatibility when chunking lands) but only USE the subset needed for
 * single-chunk synchronous request/response.
 */

// ── Control SAB layout ─────────────────────────────────────────────────────

export const CONTROL_SAB_BYTES = 256;
export const LANE_VERSION = 1;

/** Int32 offsets (in slots, not bytes) inside the control SAB. */
export const CTRL = {
  /** =1; bumps on protocol changes. */
  LANE_VERSION: 0,
  /** 0=idle, 1=req, 2=servicing, 3=poisoned */
  LANE_STATE: 1,
  /** Caller writes; servicer waits on this. */
  REQUEST_SEQ: 2,
  /** Servicer writes; caller waits on this. */
  RESPONSE_SEQ: 3,
  /** Number of calls in this `wait` envelope (N-arity). */
  BATCH_SIZE: 4,
  /** 0=done, 1=MoreReq, 2=AckReq, 3=MoreRes, 4=AckRes */
  CHUNK_STATE: 5,
  /** Bytes valid in data SAB for this chunk. */
  CHUNK_BYTES_VALID: 6,
  /** Servicer sets while dispatching a sync batch; routes outbound frames. */
  ACTIVE_SYNC_SEQ: 7,
  /** Monotonic server→client frame id. */
  SERVER_OUT_SEQ: 8,
  /** Last `SERVER_OUT_SEQ` the client has applied. */
  CLIENT_APPLIED_SEQ: 9,
  /** Set on timeout — quarantines this lane. */
  CANCEL_SEQ: 10,
  /** 0=alive, 1=dead (set by lifecycle owner on teardown). */
  CALLER_STATE: 11,
} as const;

export const LANE_STATE = {
  IDLE: 0,
  REQ: 1,
  SERVICING: 2,
  POISONED: 3,
} as const;

/**
 * Chunk-state machine. Caller and host both read/write this single slot to
 * pump request and response envelopes through the data SAB.
 *
 *   DONE      — idle, or final chunk of the request side (caller's last write).
 *   MORE_REQ  — caller wrote a non-final request chunk; host should ack + wait.
 *   ACK_REQ   — host ack'd a request chunk; caller can write the next.
 *   MORE_RES  — host wrote a non-final response chunk; caller should ack + pull.
 *   ACK_RES   — caller ack'd a response chunk; host can write the next.
 *   DONE_RES  — host wrote the final response chunk; caller decodes the
 *                accumulator and resumes.
 *
 * `DONE_RES` is distinct from `DONE` so the caller's `Atomics.wait` on
 * `CHUNK_STATE` reliably wakes when the response is ready (after the request
 * loop, `CHUNK_STATE` is left at `DONE` so we'd otherwise never see a
 * transition for a single-chunk response).
 */
export const CHUNK_STATE = {
  DONE: 0,
  MORE_REQ: 1,
  ACK_REQ: 2,
  MORE_RES: 3,
  ACK_RES: 4,
  DONE_RES: 5,
} as const;

export const CALLER_STATE = {
  ALIVE: 0,
  DEAD: 1,
} as const;

// ── Data SAB layout ────────────────────────────────────────────────────────

export const DEFAULT_DATA_SAB_BYTES = 64 * 1024;
export const MAX_DATA_SAB_BYTES = 256 * 1024;

/**
 * Per-call header inside the data SAB:
 *   [TYPE: Int32] [LEN: Int32] [INLINE_VAL: Float64] [bytes...]
 *
 * Prototype scope: we only use TYPE=0 (JSON) and read/write the envelope
 * verbatim. The fast-path TYPE enum (VOID/BOOL/F64/HANDLE_ID) is a follow-up.
 */
export const WIRE_TYPE = {
  JSON: 0,
  VOID: 1,
  BOOL: 2,
  F64: 3,
  HANDLE_ID: 4,
} as const;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Allocate fresh control + data SABs. Caller is the lifecycle owner.
 */
export function allocateLane(
  dataSabBytes: number = DEFAULT_DATA_SAB_BYTES,
): {control: SharedArrayBuffer; data: SharedArrayBuffer} {
  if (dataSabBytes > MAX_DATA_SAB_BYTES) {
    throw new Error(
      `data SAB size ${dataSabBytes} exceeds max ${MAX_DATA_SAB_BYTES}`,
    );
  }
  const control = new SharedArrayBuffer(CONTROL_SAB_BYTES);
  const data = new SharedArrayBuffer(dataSabBytes);

  // Initialize control header.
  const view = new Int32Array(control);
  Atomics.store(view, CTRL.LANE_VERSION, LANE_VERSION);
  Atomics.store(view, CTRL.LANE_STATE, LANE_STATE.IDLE);
  Atomics.store(view, CTRL.CALLER_STATE, CALLER_STATE.ALIVE);

  return {control, data};
}

/** Cheap accessor: read an Int32 slot atomically. */
export function loadCtrl(view: Int32Array, slot: number): number {
  return Atomics.load(view, slot);
}

/** Cheap accessor: write an Int32 slot atomically. */
export function storeCtrl(view: Int32Array, slot: number, value: number): void {
  Atomics.store(view, slot, value);
}

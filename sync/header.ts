/**
 * Per-call header format for the response data SAB. Each record in
 * the response timeline is laid out as:
 *
 *   `[TYPE: Int32] [LEN: Int32] [INLINE_VAL: Float64] [bytes...]`
 *
 * - TYPE selects how to interpret the record (see WIRE_TYPE in lane.ts).
 * - LEN is the byte count of the trailing payload (0 for inline-only types).
 * - INLINE_VAL carries the value for BOOL (0|1), F64 (the number),
 *   HANDLE_ID (the numeric handle id). Zero-filled and ignored for
 *   JSON and VOID.
 * - bytes (LEN bytes) follow immediately after the header for TYPE=JSON.
 *
 * Uses DataView for Int32 + Float64 field reads/writes — handles
 * arbitrary alignment cleanly and documents byte-level intent. All
 * fields are little-endian (consistent with JavaScript's typed array
 * default and SAB postMessage semantics).
 *
 * @internal — never exposed through sync/index.ts.
 */

import {WIRE_TYPE} from './lane.ts';

/** Fixed header size in bytes: Int32 (4) + Int32 (4) + Float64 (8) = 16. */
export const HEADER_SIZE = 16;

export {WIRE_TYPE};

/**
 * Encode a per-call header into `target` at `offset`. Returns the total
 * bytes written (HEADER_SIZE + payload length).
 *
 * @param target - Destination buffer.
 * @param offset - Byte offset to start writing at.
 * @param type - One of WIRE_TYPE values.
 * @param inlineVal - Value for INLINE_VAL field (default 0).
 * @param payload - Optional byte payload (for TYPE=JSON).
 * @returns Total bytes written (HEADER_SIZE + payload.byteLength).
 */
export function encodeHeader(
  target: Uint8Array,
  offset: number,
  type: number,
  inlineVal: number = 0,
  payload?: Uint8Array,
): number {
  const payloadLen = payload ? payload.byteLength : 0;
  const totalSize = HEADER_SIZE + payloadLen;

  if (offset + totalSize > target.byteLength) {
    throw new RangeError(
      `encodeHeader: buffer too small — need ${totalSize} bytes at offset ${offset}, ` +
        `but buffer is ${target.byteLength} bytes`,
    );
  }

  // Use DataView for mixed-size field writes at arbitrary alignment.
  // Little-endian throughout.
  const view = new DataView(target.buffer, target.byteOffset + offset, HEADER_SIZE);
  view.setInt32(0, type, true); // TYPE
  view.setInt32(4, payloadLen, true); // LEN
  view.setFloat64(8, inlineVal, true); // INLINE_VAL

  // Copy payload bytes immediately after the header.
  if (payload && payloadLen > 0) {
    target.set(payload, offset + HEADER_SIZE);
  }

  return totalSize;
}

/**
 * Decoded header result.
 */
export interface DecodedHeader {
  /** WIRE_TYPE value. */
  type: number;
  /** INLINE_VAL field (Float64). */
  inlineVal: number;
  /** Payload bytes (empty Uint8Array for inline-only types). */
  bytes: Uint8Array;
  /** Total bytes consumed: HEADER_SIZE + LEN. */
  totalSize: number;
}

/**
 * Decode a per-call header from `source` at `offset`.
 *
 * @param source - Source buffer.
 * @param offset - Byte offset to start reading from.
 * @returns Decoded header fields and total size consumed.
 * @throws RangeError if fewer than HEADER_SIZE bytes remain, or if
 *   LEN exceeds the remaining buffer.
 */
export function decodeHeader(
  source: Uint8Array,
  offset: number,
): DecodedHeader {
  const remaining = source.byteLength - offset;
  if (remaining < HEADER_SIZE) {
    throw new RangeError(
      `decodeHeader: need at least ${HEADER_SIZE} bytes at offset ${offset}, ` +
        `but only ${remaining} bytes remain (buffer size: ${source.byteLength})`,
    );
  }

  const view = new DataView(source.buffer, source.byteOffset + offset, HEADER_SIZE);
  const type = view.getInt32(0, true);
  const len = view.getInt32(4, true);
  const inlineVal = view.getFloat64(8, true);

  if (len < 0) {
    throw new RangeError(
      `decodeHeader: negative LEN=${len} at offset ${offset}`,
    );
  }

  const totalSize = HEADER_SIZE + len;
  if (remaining < totalSize) {
    throw new RangeError(
      `decodeHeader: record claims LEN=${len} but only ${remaining - HEADER_SIZE} payload bytes ` +
        `remain at offset ${offset + HEADER_SIZE} (buffer size: ${source.byteLength})`,
    );
  }

  // Slice out payload bytes. For inline-only types (VOID, BOOL, F64,
  // HANDLE_ID) this will be an empty Uint8Array (len=0).
  const bytes = source.slice(
    offset + HEADER_SIZE,
    offset + HEADER_SIZE + len,
  );

  return {type, inlineVal, bytes, totalSize};
}

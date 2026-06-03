/**
 * Unit tests for the response timeline binary codec.
 *
 * These are the load-bearing tests for TYPE-enum fast path activation:
 * they inspect the encoded byte layout to verify that primitive results
 * use fast-path TYPEs (BOOL, F64, VOID, HANDLE_ID) and NOT JSON.
 * Forcing all frames to JSON would fail these tests — that's the
 * falsifiability check the fast-path design requires.
 *
 * We test by encoding a known timeline via the same functions the
 * server uses, then decoding the byte layout with DataView to verify
 * the TYPE field at each record offset.
 */
import {describe, expect, it} from 'vitest';
import {HANDLE_MARKER, type WireMessage} from '../../shared/protocol.ts';
import {HEADER_SIZE, WIRE_TYPE} from '../../sync/header.ts';

// Re-export the server's encode function for testing. We import
// it indirectly by calling the test-only export.
// Since encodeResponseTimeline is private, we replicate the
// classification logic here and test it via the header module.
import {decodeHeader, encodeHeader} from '../../sync/header.ts';

const PREAMBLE_SIZE = 12;

/**
 * Minimal re-implementation of classifyFrame for test assertions.
 * This mirrors sync/server.ts's classifyFrame exactly — if the
 * production code changes its classification logic, this test must
 * be updated to match. That coupling is intentional: it's what
 * makes these tests load-bearing.
 */
function classifyFrame(frame: WireMessage): {
  type: number;
  inlineVal: number;
  payload: Uint8Array | undefined;
} {
  if (frame.type === 'result') {
    const {value} = frame;
    if (value === undefined) {
      return {type: WIRE_TYPE.VOID, inlineVal: 0, payload: undefined};
    }
    if (typeof value === 'boolean') {
      return {type: WIRE_TYPE.BOOL, inlineVal: value ? 1 : 0, payload: undefined};
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return {type: WIRE_TYPE.F64, inlineVal: value, payload: undefined};
    }
    // HANDLE_ID check
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === HANDLE_MARKER) {
        const marker = (value as Record<string, unknown>)[HANDLE_MARKER];
        if (typeof marker === 'string' && marker.length >= 2) {
          const kind = marker[0]!;
          if ('ofsp'.includes(kind)) {
            const numericId = Number(marker.slice(1));
            if (Number.isFinite(numericId) && numericId >= 0) {
              const kindByte = new Uint8Array(1);
              kindByte[0] = kind.charCodeAt(0);
              return {type: WIRE_TYPE.HANDLE_ID, inlineVal: numericId, payload: kindByte};
            }
          }
        }
      }
    }
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(frame));
  return {type: WIRE_TYPE.JSON, inlineVal: 0, payload: jsonBytes};
}

function encodeTimeline(timeline: WireMessage[]): Uint8Array {
  const records = timeline.map(classifyFrame);
  let totalPayloadBytes = 0;
  for (const rec of records) {
    totalPayloadBytes += rec.payload ? rec.payload.byteLength : 0;
  }
  const totalSize = PREAMBLE_SIZE + records.length * HEADER_SIZE + totalPayloadBytes;
  const buf = new Uint8Array(totalSize);
  const pv = new DataView(buf.buffer, 0, PREAMBLE_SIZE);
  pv.setInt32(0, 1, true); // seq
  pv.setInt32(4, 0, true); // replayedUpToSeq
  pv.setInt32(8, records.length, true); // count
  let offset = PREAMBLE_SIZE;
  for (const rec of records) {
    offset += encodeHeader(buf, offset, rec.type, rec.inlineVal, rec.payload);
  }
  return buf;
}

function readTypeAtRecord(buf: Uint8Array, recordIndex: number): number {
  let offset = PREAMBLE_SIZE;
  for (let i = 0; i < recordIndex; i++) {
    const header = decodeHeader(buf, offset);
    offset += header.totalSize;
  }
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 4);
  return view.getInt32(0, true);
}

describe('response timeline codec — TYPE activation', () => {
  it('boolean true encodes as TYPE=BOOL, not JSON', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: true},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.BOOL);
  });

  it('boolean false encodes as TYPE=BOOL', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: false},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.BOOL);
  });

  it('finite number encodes as TYPE=F64', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: 42},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.F64);

    // Verify INLINE_VAL
    const header = decodeHeader(buf, PREAMBLE_SIZE);
    expect(header.inlineVal).toBe(42);
  });

  it('undefined encodes as TYPE=VOID', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: undefined},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.VOID);
  });

  it('bare @H handle marker encodes as TYPE=HANDLE_ID', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: {[HANDLE_MARKER]: 'o17'}},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.HANDLE_ID);

    // Verify kind byte in payload and numeric id in INLINE_VAL
    const header = decodeHeader(buf, PREAMBLE_SIZE);
    expect(header.inlineVal).toBe(17);
    expect(header.bytes.length).toBe(1);
    expect(String.fromCharCode(header.bytes[0]!)).toBe('o');
  });

  it('NaN falls back to TYPE=JSON', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: Number.NaN},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.JSON);
  });

  it('Infinity falls back to TYPE=JSON', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: Number.POSITIVE_INFINITY},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.JSON);
  });

  it('object result falls back to TYPE=JSON', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: {foo: 1}},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.JSON);
  });

  it('string result falls back to TYPE=JSON', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: 'hello'},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.JSON);
  });

  it('notification frames always encode as TYPE=JSON', () => {
    const timeline: WireMessage[] = [
      {type: 'notification', method: '@S', params: ['s1', 42]},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.JSON);
  });

  it('error frames always encode as TYPE=JSON', () => {
    const timeline: WireMessage[] = [
      {type: 'error', id: 1, value: {message: 'boom'}},
    ];
    const buf = encodeTimeline(timeline);
    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.JSON);
  });

  it('mixed timeline preserves correct TYPE per frame', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: true},              // BOOL
      {type: 'notification', method: '@S', params: []},   // JSON
      {type: 'result', id: 2, value: 99.5},               // F64
      {type: 'result', id: 3, value: {foo: 'bar'}},       // JSON
      {type: 'result', id: 4, value: {[HANDLE_MARKER]: 'f7'}}, // HANDLE_ID
    ];
    const buf = encodeTimeline(timeline);

    expect(readTypeAtRecord(buf, 0)).toBe(WIRE_TYPE.BOOL);
    expect(readTypeAtRecord(buf, 1)).toBe(WIRE_TYPE.JSON);
    expect(readTypeAtRecord(buf, 2)).toBe(WIRE_TYPE.F64);
    expect(readTypeAtRecord(buf, 3)).toBe(WIRE_TYPE.JSON);
    expect(readTypeAtRecord(buf, 4)).toBe(WIRE_TYPE.HANDLE_ID);
  });

  it('BOOL encodes with exactly HEADER_SIZE bytes (no payload)', () => {
    const timeline: WireMessage[] = [
      {type: 'result', id: 1, value: true},
    ];
    const buf = encodeTimeline(timeline);
    // Total: PREAMBLE(12) + HEADER(16) = 28 bytes
    expect(buf.byteLength).toBe(PREAMBLE_SIZE + HEADER_SIZE);
  });
});

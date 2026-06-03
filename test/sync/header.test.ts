/**
 * Unit tests for the per-call header encode/decode helpers.
 * Validates round-trip correctness for every WIRE_TYPE, edge cases
 * (empty payload, large payload, back-to-back headers), and error
 * conditions (truncated buffer, oversized LEN).
 */
import {describe, expect, it} from 'vitest';
import {
  decodeHeader,
  encodeHeader,
  HEADER_SIZE,
  WIRE_TYPE,
} from '../../sync/header.ts';

describe('header', () => {
  // ── Constants ──────────────────────────────────────────────────────
  it('HEADER_SIZE is 16 bytes', () => {
    expect(HEADER_SIZE).toBe(16);
  });

  // ── Round-trip: VOID ───────────────────────────────────────────────
  describe('VOID', () => {
    it('round-trips with exactly HEADER_SIZE bytes', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      const written = encodeHeader(buf, 0, WIRE_TYPE.VOID);
      expect(written).toBe(HEADER_SIZE);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.VOID);
      expect(decoded.inlineVal).toBe(0);
      expect(decoded.bytes.byteLength).toBe(0);
      expect(decoded.totalSize).toBe(HEADER_SIZE);
    });
  });

  // ── Round-trip: BOOL ───────────────────────────────────────────────
  describe('BOOL', () => {
    it('round-trips true (INLINE_VAL=1)', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.BOOL, 1);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.BOOL);
      expect(decoded.inlineVal).toBe(1);
      expect(decoded.bytes.byteLength).toBe(0);
      expect(decoded.totalSize).toBe(HEADER_SIZE);
    });

    it('round-trips false (INLINE_VAL=0)', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.BOOL, 0);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.BOOL);
      expect(decoded.inlineVal).toBe(0);
    });
  });

  // ── Round-trip: F64 ────────────────────────────────────────────────
  describe('F64', () => {
    it('round-trips 42', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.F64, 42);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.F64);
      expect(decoded.inlineVal).toBe(42);
    });

    it('round-trips negative numbers', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.F64, -3.14);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.F64);
      expect(decoded.inlineVal).toBeCloseTo(-3.14, 10);
    });

    it('round-trips Number.MAX_SAFE_INTEGER + 1', () => {
      const val = Number.MAX_SAFE_INTEGER + 1;
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.F64, val);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.inlineVal).toBe(val);
    });

    it('round-trips zero', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.F64, 0);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.inlineVal).toBe(0);
    });

    it('round-trips Number.MIN_VALUE (smallest positive subnormal)', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.F64, Number.MIN_VALUE);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.inlineVal).toBe(Number.MIN_VALUE);
    });
  });

  // ── Round-trip: HANDLE_ID ──────────────────────────────────────────
  describe('HANDLE_ID', () => {
    it('round-trips a handle id', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.HANDLE_ID, 17);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.HANDLE_ID);
      expect(decoded.inlineVal).toBe(17);
      expect(decoded.bytes.byteLength).toBe(0);
    });
  });

  // ── Round-trip: JSON ───────────────────────────────────────────────
  describe('JSON', () => {
    it('round-trips with a small payload', () => {
      const payload = new TextEncoder().encode('{"foo":1}');
      const buf = new Uint8Array(HEADER_SIZE + payload.byteLength);
      const written = encodeHeader(buf, 0, WIRE_TYPE.JSON, 0, payload);
      expect(written).toBe(HEADER_SIZE + payload.byteLength);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.JSON);
      expect(decoded.inlineVal).toBe(0);
      expect(decoded.bytes.byteLength).toBe(payload.byteLength);
      expect(new TextDecoder().decode(decoded.bytes)).toBe('{"foo":1}');
      expect(decoded.totalSize).toBe(HEADER_SIZE + payload.byteLength);
    });

    it('round-trips with empty payload (LEN=0)', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      const written = encodeHeader(buf, 0, WIRE_TYPE.JSON, 0);
      expect(written).toBe(HEADER_SIZE);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.type).toBe(WIRE_TYPE.JSON);
      expect(decoded.bytes.byteLength).toBe(0);
    });

    it('round-trips with a multi-KB payload', () => {
      const largeJson = JSON.stringify({data: 'x'.repeat(4096)});
      const payload = new TextEncoder().encode(largeJson);
      const buf = new Uint8Array(HEADER_SIZE + payload.byteLength);
      encodeHeader(buf, 0, WIRE_TYPE.JSON, 0, payload);

      const decoded = decodeHeader(buf, 0);
      expect(decoded.bytes.byteLength).toBe(payload.byteLength);
      expect(new TextDecoder().decode(decoded.bytes)).toBe(largeJson);
    });
  });

  // ── Sequential offsets ─────────────────────────────────────────────
  describe('sequential records', () => {
    it('decodes back-to-back headers at correct offsets', () => {
      // Record 1: BOOL true
      // Record 2: F64 99.5
      // Record 3: JSON payload
      const jsonPayload = new TextEncoder().encode('{"a":"b"}');
      const totalSize = HEADER_SIZE * 3 + jsonPayload.byteLength;
      const buf = new Uint8Array(totalSize);

      let offset = 0;
      offset += encodeHeader(buf, offset, WIRE_TYPE.BOOL, 1);
      offset += encodeHeader(buf, offset, WIRE_TYPE.F64, 99.5);
      offset += encodeHeader(buf, offset, WIRE_TYPE.JSON, 0, jsonPayload);
      expect(offset).toBe(totalSize);

      // Decode sequentially
      let readOffset = 0;
      const r1 = decodeHeader(buf, readOffset);
      expect(r1.type).toBe(WIRE_TYPE.BOOL);
      expect(r1.inlineVal).toBe(1);
      readOffset += r1.totalSize;

      const r2 = decodeHeader(buf, readOffset);
      expect(r2.type).toBe(WIRE_TYPE.F64);
      expect(r2.inlineVal).toBe(99.5);
      readOffset += r2.totalSize;

      const r3 = decodeHeader(buf, readOffset);
      expect(r3.type).toBe(WIRE_TYPE.JSON);
      expect(new TextDecoder().decode(r3.bytes)).toBe('{"a":"b"}');
      readOffset += r3.totalSize;

      expect(readOffset).toBe(totalSize);
    });

    it('handles VOID records interspersed with JSON', () => {
      const json1 = new TextEncoder().encode('"hello"');
      const json2 = new TextEncoder().encode('[1,2,3]');
      const totalSize = HEADER_SIZE * 3 + json1.byteLength + json2.byteLength;
      const buf = new Uint8Array(totalSize);

      let offset = 0;
      offset += encodeHeader(buf, offset, WIRE_TYPE.JSON, 0, json1);
      offset += encodeHeader(buf, offset, WIRE_TYPE.VOID);
      offset += encodeHeader(buf, offset, WIRE_TYPE.JSON, 0, json2);
      expect(offset).toBe(totalSize);

      let readOffset = 0;
      const r1 = decodeHeader(buf, readOffset);
      expect(r1.type).toBe(WIRE_TYPE.JSON);
      readOffset += r1.totalSize;

      const r2 = decodeHeader(buf, readOffset);
      expect(r2.type).toBe(WIRE_TYPE.VOID);
      readOffset += r2.totalSize;

      const r3 = decodeHeader(buf, readOffset);
      expect(r3.type).toBe(WIRE_TYPE.JSON);
      expect(new TextDecoder().decode(r3.bytes)).toBe('[1,2,3]');
    });
  });

  // ── Error conditions ───────────────────────────────────────────────
  describe('error conditions', () => {
    it('throws when buffer is too small for header on decode', () => {
      const buf = new Uint8Array(10); // Less than HEADER_SIZE
      expect(() => decodeHeader(buf, 0)).toThrow(RangeError);
      expect(() => decodeHeader(buf, 0)).toThrow(/need at least 16 bytes/);
    });

    it('throws when offset leaves fewer than HEADER_SIZE bytes', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      expect(() => decodeHeader(buf, 1)).toThrow(RangeError);
    });

    it('throws when LEN exceeds remaining buffer on decode', () => {
      // Encode a JSON record with 10-byte payload, but only provide
      // the header + 5 bytes.
      const buf = new Uint8Array(HEADER_SIZE + 5);
      const view = new DataView(buf.buffer);
      view.setInt32(0, WIRE_TYPE.JSON, true);
      view.setInt32(4, 10, true); // Claims 10 bytes but only 5 available
      view.setFloat64(8, 0, true);

      expect(() => decodeHeader(buf, 0)).toThrow(RangeError);
      expect(() => decodeHeader(buf, 0)).toThrow(/payload bytes/);
    });

    it('throws when target buffer is too small for encode', () => {
      const buf = new Uint8Array(10); // Too small for HEADER_SIZE
      expect(() => encodeHeader(buf, 0, WIRE_TYPE.VOID)).toThrow(RangeError);
    });

    it('throws when target buffer is too small for header + payload', () => {
      const payload = new Uint8Array(100);
      const buf = new Uint8Array(HEADER_SIZE + 50); // Too small for payload
      expect(() =>
        encodeHeader(buf, 0, WIRE_TYPE.JSON, 0, payload),
      ).toThrow(RangeError);
    });
  });

  // ── INLINE_VAL field for non-applicable types ──────────────────────
  describe('INLINE_VAL for non-applicable types', () => {
    it('VOID encodes INLINE_VAL as 0 (zero-filled)', () => {
      const buf = new Uint8Array(HEADER_SIZE);
      encodeHeader(buf, 0, WIRE_TYPE.VOID);

      const view = new DataView(buf.buffer);
      expect(view.getFloat64(8, true)).toBe(0);
    });

    it('JSON encodes INLINE_VAL as 0 (zero-filled)', () => {
      const payload = new TextEncoder().encode('{}');
      const buf = new Uint8Array(HEADER_SIZE + payload.byteLength);
      encodeHeader(buf, 0, WIRE_TYPE.JSON, 0, payload);

      const view = new DataView(buf.buffer);
      expect(view.getFloat64(8, true)).toBe(0);
    });
  });
});

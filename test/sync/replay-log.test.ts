/**
 * Unit tests for the `ReplayLog` data structure backing the drain
 * barrier. Pure data — no SAB, no transport, no workers.
 */
import {describe, expect, it} from 'vitest';
import type {WireMessage} from '../../shared/protocol.ts';
import {ReplayLog} from '../../sync/replay-log.ts';

function notification(method: string, seq?: number): WireMessage {
  return {
    type: 'notification',
    method,
    params: seq != null ? [seq] : [],
  };
}

describe('ReplayLog', () => {
  describe('push + iterate', () => {
    it('stores frames and retrieves them via framesAfter', () => {
      const log = new ReplayLog();
      log.push(1, notification('@S', 1));
      log.push(2, notification('@S', 2));
      log.push(3, notification('@S', 3));

      const {frames, gap} = log.framesAfter(0);
      expect(frames).toHaveLength(3);
      expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
      expect(gap).toBe(false);
    });

    it('framesAfter filters by seq', () => {
      const log = new ReplayLog();
      log.push(1, notification('@S', 1));
      log.push(2, notification('@S', 2));
      log.push(3, notification('@S', 3));

      const {frames} = log.framesAfter(2);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.seq).toBe(3);
    });

    it('framesAfter returns empty when all frames are at or below watermark', () => {
      const log = new ReplayLog();
      log.push(1, notification('@S', 1));
      log.push(2, notification('@S', 2));

      const {frames, gap} = log.framesAfter(2);
      expect(frames).toHaveLength(0);
      expect(gap).toBe(false);
    });

    it('framesAfter on empty log returns empty without gap', () => {
      const log = new ReplayLog();
      const {frames, gap} = log.framesAfter(0);
      expect(frames).toHaveLength(0);
      expect(gap).toBe(false);
    });
  });

  describe('size, oldestSeq, latestSeq', () => {
    it('reports correct size', () => {
      const log = new ReplayLog();
      expect(log.size()).toBe(0);
      log.push(1, notification('@S'));
      expect(log.size()).toBe(1);
      log.push(2, notification('@S'));
      expect(log.size()).toBe(2);
    });

    it('reports 0 for oldestSeq / latestSeq on empty log', () => {
      const log = new ReplayLog();
      expect(log.oldestSeq()).toBe(0);
      expect(log.latestSeq()).toBe(0);
    });

    it('reports correct oldest and latest seq', () => {
      const log = new ReplayLog();
      log.push(5, notification('@S'));
      log.push(6, notification('@S'));
      log.push(7, notification('@S'));
      expect(log.oldestSeq()).toBe(5);
      expect(log.latestSeq()).toBe(7);
    });
  });

  describe('dropUpTo', () => {
    it('drops frames up to and including watermark', () => {
      const log = new ReplayLog();
      log.push(1, notification('@S'));
      log.push(2, notification('@S'));
      log.push(3, notification('@S'));
      log.push(4, notification('@S'));

      log.dropUpTo(2);
      expect(log.size()).toBe(2);
      expect(log.oldestSeq()).toBe(3);
      expect(log.latestSeq()).toBe(4);
    });

    it('drops entire log when watermark >= latestSeq', () => {
      const log = new ReplayLog();
      log.push(1, notification('@S'));
      log.push(2, notification('@S'));

      log.dropUpTo(5);
      expect(log.size()).toBe(0);
      expect(log.oldestSeq()).toBe(0);
      expect(log.latestSeq()).toBe(0);
    });

    it('is a no-op when watermark < oldestSeq', () => {
      const log = new ReplayLog();
      log.push(5, notification('@S'));
      log.push(6, notification('@S'));

      log.dropUpTo(4);
      expect(log.size()).toBe(2);
    });

    it('preserves monotonic seq after drop + push', () => {
      const log = new ReplayLog();
      log.push(1, notification('@S'));
      log.push(2, notification('@S'));
      log.push(3, notification('@S'));

      log.dropUpTo(2);
      // Push continues from seq > 3
      log.push(4, notification('@S'));
      expect(log.size()).toBe(2);
      expect(log.oldestSeq()).toBe(3);
      expect(log.latestSeq()).toBe(4);
    });
  });

  describe('hard-cap overflow (maxFrames)', () => {
    it('evicts oldest frames when exceeding maxFrames', () => {
      const log = new ReplayLog({maxFrames: 5});
      for (let i = 1; i <= 10; i++) {
        log.push(i, notification('@S', i));
      }
      expect(log.size()).toBe(5);
      expect(log.oldestSeq()).toBe(6);
      expect(log.latestSeq()).toBe(10);
    });

    it('push returns true when eviction occurred', () => {
      const log = new ReplayLog({maxFrames: 2});
      expect(log.push(1, notification('@S'))).toBe(false);
      expect(log.push(2, notification('@S'))).toBe(false);
      expect(log.push(3, notification('@S'))).toBe(true);
    });

    it('pushing 2000 frames into a 1024-frame log leaves exactly 1024', () => {
      const log = new ReplayLog({maxFrames: 1024});
      for (let i = 1; i <= 2000; i++) {
        log.push(i, notification('@S', i));
      }
      expect(log.size()).toBe(1024);
      expect(log.oldestSeq()).toBe(977);
      expect(log.latestSeq()).toBe(2000);
      expect(log.framesLost).toBe(true);
    });
  });

  describe('hard-cap overflow (maxBytes)', () => {
    it('evicts oldest frames when exceeding maxBytes', () => {
      // Use a very small byte cap so a few frames trigger eviction.
      const log = new ReplayLog({maxBytes: 500, maxFrames: 1000});
      let evicted = false;
      for (let i = 1; i <= 20; i++) {
        if (log.push(i, notification('@S', i))) evicted = true;
      }
      expect(evicted).toBe(true);
      expect(log.size()).toBeGreaterThan(0);
      expect(log.size()).toBeLessThan(20);
      expect(log.latestSeq()).toBe(20);
    });
  });

  describe('framesAfter gap detection', () => {
    it('signals gap when afterSeq is before oldestSeq', () => {
      const log = new ReplayLog({maxFrames: 3});
      for (let i = 1; i <= 5; i++) {
        log.push(i, notification('@S', i));
      }
      // Log holds seqs 3, 4, 5. Asking for frames after seq 1.
      const {frames, gap} = log.framesAfter(1);
      expect(gap).toBe(true);
      expect(frames).toHaveLength(3);
      expect(frames.map((f) => f.seq)).toEqual([3, 4, 5]);
    });

    it('no gap when afterSeq is exactly oldestSeq - 1', () => {
      const log = new ReplayLog({maxFrames: 3});
      log.push(3, notification('@S'));
      log.push(4, notification('@S'));
      log.push(5, notification('@S'));

      // afterSeq = 2 = oldestSeq - 1 → no gap
      const {gap} = log.framesAfter(2);
      expect(gap).toBe(false);
    });

    it('gap when afterSeq is before oldestSeq - 1', () => {
      const log = new ReplayLog({maxFrames: 3});
      log.push(3, notification('@S'));
      log.push(4, notification('@S'));
      log.push(5, notification('@S'));

      // afterSeq = 1 < oldestSeq - 1 = 2 → gap
      const {gap} = log.framesAfter(1);
      expect(gap).toBe(true);
    });
  });

  describe('non-monotonic seq', () => {
    it('throws on non-monotonic push', () => {
      const log = new ReplayLog();
      log.push(5, notification('@S'));
      expect(() => log.push(3, notification('@S'))).toThrow(
        /non-monotonic seq/,
      );
    });

    it('throws on equal seq push', () => {
      const log = new ReplayLog();
      log.push(5, notification('@S'));
      expect(() => log.push(5, notification('@S'))).toThrow(
        /non-monotonic seq/,
      );
    });
  });
});

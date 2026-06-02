import type {WireMessage} from '../shared/protocol.ts';

/**
 * Result of a `framesAfter` query. Contains the frames and a flag
 * indicating whether any frames were lost due to hard-cap eviction
 * before the requested starting seq.
 */
export interface ReplaySlice {
  /** Frames with `seq > afterSeq`, in monotonic-seq order. */
  frames: ReadonlyArray<{seq: number; msg: WireMessage}>;
  /**
   * `true` when the requested `afterSeq` is less than `oldestSeq` —
   * meaning frames between `afterSeq` and `oldestSeq - 1` have been
   * evicted by the hard-cap and cannot be replayed. The host's replay
   * step uses this to decide whether to surface a diagnostic.
   */
  gap: boolean;
}

/**
 * Bounded ring of `{seq, msg}` entries representing outbound async
 * frames the host has shipped. Backs the drain-barrier protocol by
 * letting the host replay missed frames into the response timeline.
 *
 * Hard caps: `maxBytes` (default 256 KiB) OR `maxFrames` (default
 * 1024), whichever is hit first. Oldest frames are evicted on
 * overflow.
 *
 * **Frame size estimation.** Uses a fixed per-frame overhead constant
 * (64 bytes) plus `JSON.stringify(msg).length * 2` for the payload.
 * The `* 2` accounts for JS string internal encoding (UTF-16). This
 * is slightly inaccurate (JSON.stringify is called on every push) but
 * more faithful than a fixed constant, and the push path is only
 * taken on the idle (async) path — never on the hot sync dispatch.
 * A pure fixed-constant alternative would under-count large payloads
 * and over-count small ones, making the byte cap unreliable.
 *
 * @internal — never exposed through `sync/index.ts`.
 */
export class ReplayLog {
  private entries: Array<{seq: number; msg: WireMessage; size: number}> = [];
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly maxFrames: number;

  /** Tracks whether any frame was lost to hard-cap eviction. */
  private _framesLost = false;

  /** Fixed per-frame overhead for size estimation (bytes). */
  private static readonly FRAME_OVERHEAD = 64;

  constructor(opts?: {maxBytes?: number; maxFrames?: number}) {
    this.maxBytes = opts?.maxBytes ?? 256 * 1024;
    this.maxFrames = opts?.maxFrames ?? 1024;
  }

  /**
   * Append a frame to the log. `seq` must be monotonically increasing
   * relative to the previous push — non-monotonic input throws in
   * debug builds (i.e. always, since there is no "release mode" in
   * JS).
   *
   * Returns `true` if one or more frames were evicted to stay within
   * the hard cap.
   */
  push(seq: number, msg: WireMessage): boolean {
    if (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1]!;
      if (seq <= last.seq) {
        throw new Error(
          `ReplayLog: non-monotonic seq (${seq} <= ${last.seq})`,
        );
      }
    }

    const size = ReplayLog.estimateSize(msg);
    this.entries.push({seq, msg, size});
    this.totalBytes += size;

    let evicted = false;

    // Evict oldest until within hard caps.
    while (
      this.entries.length > this.maxFrames ||
      this.totalBytes > this.maxBytes
    ) {
      const removed = this.entries.shift()!;
      this.totalBytes -= removed.size;
      evicted = true;
      this._framesLost = true;
    }

    return evicted;
  }

  /**
   * Drop all frames with `seq <= watermark`. Called when the host
   * learns (via `clientAppliedSeq`) that the worker has confirmed
   * application up to `watermark`.
   */
  dropUpTo(watermark: number): void {
    while (this.entries.length > 0 && this.entries[0]!.seq <= watermark) {
      this.totalBytes -= this.entries[0]!.size;
      this.entries.shift();
    }
  }

  /**
   * Return all frames with `seq > afterSeq` in monotonic order, plus
   * a `gap` flag indicating whether some frames before `afterSeq`
   * have been evicted (i.e. `afterSeq < oldestSeq`).
   */
  framesAfter(afterSeq: number): ReplaySlice {
    const gap =
      this.entries.length > 0 && afterSeq < this.entries[0]!.seq - 1;
    const frames: Array<{seq: number; msg: WireMessage}> = [];
    for (const entry of this.entries) {
      if (entry.seq > afterSeq) {
        frames.push({seq: entry.seq, msg: entry.msg});
      }
    }
    return {frames, gap};
  }

  /** Number of frames currently in the log. */
  size(): number {
    return this.entries.length;
  }

  /** Seq of the oldest frame, or `0` if the log is empty. */
  oldestSeq(): number {
    return this.entries.length > 0 ? this.entries[0]!.seq : 0;
  }

  /** Seq of the newest frame, or `0` if the log is empty. */
  latestSeq(): number {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1]!.seq
      : 0;
  }

  /** Whether any frame has been lost to hard-cap eviction. */
  get framesLost(): boolean {
    return this._framesLost;
  }

  /** Estimate the memory footprint of a single frame. */
  private static estimateSize(msg: WireMessage): number {
    // JSON.stringify is called on the idle (async) path, not the hot
    // sync dispatch path. The cost is acceptable for bookkeeping.
    // Wrapped in try/catch because raw transports can carry values
    // that JSON.stringify throws on (bigint, cyclic refs, etc.).
    // A conservative fallback ensures the byte cap stays defensive.
    try {
      return ReplayLog.FRAME_OVERHEAD + JSON.stringify(msg).length * 2;
    } catch {
      // Conservative: assume 1 KiB for non-serializable frames.
      return ReplayLog.FRAME_OVERHEAD + 1024;
    }
  }
}

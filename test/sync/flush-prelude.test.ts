/**
 * Unit tests for ClientReflection.flushForSyncPrelude().
 * Validates synchronous drain of pending @W / @U / @D batches,
 * timer cancellation, idempotency, and post-flush scheduling.
 */
import {describe, expect, it, vi} from 'vitest';
import {ClientReflection} from '../../client/reflection.ts';
import type {RPCClient} from '../../client/rpc.ts';
import type {WireMessage} from '../../shared/protocol.ts';

/**
 * Create a minimal mock RPCClient with just enough surface for
 * ClientReflection. Captures notify() calls for assertion.
 */
function createMockRpc(): {
  rpc: RPCClient;
  notifyCalls: Array<{method: string; params: unknown[]}>;
} {
  const notifyCalls: Array<{method: string; params: unknown[]}> = [];
  const rpc = {
    notify(method: string, params?: unknown[]) {
      notifyCalls.push({method, params: params ?? []});
    },
    call: vi.fn(),
    _sendCall: vi.fn(),
  } as unknown as RPCClient;
  return {rpc, notifyCalls};
}

describe('ClientReflection.flushForSyncPrelude', () => {
  it('returns a @W notification for pending watch', () => {
    const {rpc} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    reflection.scheduleWatch('s1');
    const prelude = reflection.flushForSyncPrelude();

    expect(prelude).toHaveLength(1);
    expect(prelude[0]).toEqual({
      type: 'notification',
      method: '@W',
      params: ['s1'],
    });
  });

  it('returns empty array when no batches are pending', () => {
    const {rpc} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    const prelude = reflection.flushForSyncPrelude();
    expect(prelude).toEqual([]);
  });

  it('clears the watch batch after flush', () => {
    const {rpc} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    reflection.scheduleWatch('s1');
    reflection.flushForSyncPrelude();

    // Second flush should be empty
    const second = reflection.flushForSyncPrelude();
    expect(second).toEqual([]);
  });

  it('returns entries for all three batches in W, U, D order', () => {
    const {rpc} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    reflection.scheduleWatch('s1');
    reflection.scheduleUnwatch('s2');
    reflection.scheduleRelease('o3'); // Only o/f kinds participate

    const prelude = reflection.flushForSyncPrelude();

    expect(prelude).toHaveLength(3);
    expect(prelude[0]!.method).toBe('@W');
    expect(prelude[0]!.params).toEqual(['s1']);
    expect(prelude[1]!.method).toBe('@U');
    expect(prelude[1]!.params).toEqual(['s2']);
    expect(prelude[2]!.method).toBe('@D');
    expect(prelude[2]!.params).toEqual(['o3']);
  });

  it('cancels debounce timers so they do not fire after flush', async () => {
    const {rpc, notifyCalls} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    reflection.scheduleWatch('s1');
    reflection.flushForSyncPrelude();

    // Wait longer than the debounce window (1ms for watch)
    await new Promise((r) => setTimeout(r, 20));

    // The debounce should NOT have fired via rpc.notify
    expect(notifyCalls).toHaveLength(0);
  });

  it('new schedules after flush fire on their own debounce cycle', async () => {
    const {rpc, notifyCalls} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    reflection.scheduleWatch('s1');
    reflection.flushForSyncPrelude();

    // Schedule a new watch after flush
    reflection.scheduleWatch('s2');

    // Wait for the debounce to fire
    await new Promise((r) => setTimeout(r, 20));

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]!.method).toBe('@W');
    expect(notifyCalls[0]!.params).toEqual(['s2']);
  });

  it('consecutive flushes in the same tick: only first has content', () => {
    const {rpc} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    reflection.scheduleWatch('s1');

    const first = reflection.flushForSyncPrelude();
    const second = reflection.flushForSyncPrelude();
    const third = reflection.flushForSyncPrelude();

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(third).toEqual([]);
  });

  it('handles multiple ids in a single batch', () => {
    const {rpc} = createMockRpc();
    const reflection = new ClientReflection(rpc);

    reflection.scheduleWatch('s1');
    reflection.scheduleWatch('s2');
    reflection.scheduleWatch('s3');

    const prelude = reflection.flushForSyncPrelude();

    expect(prelude).toHaveLength(1);
    expect(prelude[0]!.method).toBe('@W');
    const ids = prelude[0]!.params as string[];
    expect(ids).toHaveLength(3);
    expect(ids).toContain('s1');
    expect(ids).toContain('s2');
    expect(ids).toContain('s3');
  });
});

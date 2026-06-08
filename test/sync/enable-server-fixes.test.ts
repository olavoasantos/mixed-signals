/**
 * Regression tests for the round-1 critical / important findings
 * against `enableSyncServer`:
 *
 *   - Caller-timeout-and-retry no longer leaks a suspended
 *     `serviceSyncRequest` async frame on the host. The
 *     `BatchContext` refactor aborts the prior batch when a new
 *     doorbell arrives, so the second batch completes cleanly.
 *
 *   - The request-side `Atomics.wait` honours `timeoutMs`. A host
 *     that stalls between MORE_REQ acks no longer wedges the worker
 *     forever; `SyncRPCTimeoutError` fires within the budget.
 *
 * The host-side leak isn't directly observable from outside (it's a
 * memory + suspended-frame leak), so we exercise the structural
 * property: after a timeout-and-retry sequence, a subsequent batch
 * completes correctly. Before the fix this would hang because the
 * prior `await allDone` in `serviceSyncRequest` had been orphaned by
 * module-scope state overwriting.
 */
import {afterEach, describe, expect, it} from 'vitest';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NodeTestHarness, createRawTransport} from '../harness/index.ts';
import {RPC} from '../../server/rpc.ts';
import {enableSyncServer} from '../../sync/server.ts';

const ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../harness/__fixtures__/node-worker-entry.ts',
);

async function createTransportHarness(root: object) {
  const harness = new NodeTestHarness({client: {entry: ENTRY}});
  const transport = createRawTransport(harness.host);
  const syncTransport = enableSyncServer(transport);
  const rpc = new RPC(root);
  rpc.addClient(syncTransport);
  await harness.ready;

  await harness.client.evaluate(`async () => {
    const {workerData} = await import('node:worker_threads');
    const {enableSyncClient} = await import('../../../sync/client.ts');
    const port = workerData.port;
    const base = {
      mode: 'raw',
      send(data) { port.postMessage(data); },
      onMessage(cb) { port.on('message', (d) => cb(d)); },
    };
    const transport = await enableSyncClient(base, {timeoutMs: 5000});
    transport.onMessage(() => {});
    globalThis._transport = transport;
  }`);

  return {harness, rpc};
}

describe('enableSyncServer — caller timeout + retry sequence', () => {
  let harness: NodeTestHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('a second batch succeeds after a caller-side timeout on the first', async () => {
    // The root provides a method that never resolves (the first
    // call) and a method that returns a value (the retry). Before
    // the BatchContext refactor, the second call would hang because
    // the prior `serviceSyncRequest` frame had orphaned the new
    // batch's resolve handle.
    const {harness: h, rpc: _rpc} = await createTransportHarness({
      hang() {
        return new Promise(() => {
          /* never resolves */
        });
      },
      add(a: number, b: number) {
        return a + b;
      },
    });
    harness = h;

    // First batch: times out at the caller. The host enters
    // `serviceSyncRequest` and awaits forever; on caller timeout we
    // expect SyncRPCTimeoutError back to the test harness.
    const firstResult = (await harness.client.evaluate(`() => {
      try {
        globalThis._transport.wait(
          [{type: 'call', id: 1000000, method: 'hang', params: []}],
          {timeoutMs: 50}
        );
        return {threw: false};
      } catch (err) {
        return {threw: true, errorName: err.name};
      }
    }`)) as any;
    expect(firstResult.threw).toBe(true);
    expect(firstResult.errorName).toBe('SyncRPCTimeoutError');

    // Second batch: must succeed. Before the fix this hung because
    // the prior batch's module-scope state was clobbered by the
    // retry, leaving the prior batch's `await allDone` permanently
    // unresolved and the retry's `serviceSyncRequest` frame writing
    // into already-overwritten state. After the fix, the new
    // doorbell aborts the prior batch (sets aborted=true, resolves
    // its done), the prior frame bails without publishing, and the
    // new batch's context is fresh.
    const secondResult = (await harness.client.evaluate(`() => {
      return globalThis._transport.wait(
        [{type: 'call', id: 1000001, method: 'add', params: [2, 3]}],
        {timeoutMs: 1000}
      );
    }`)) as any[];
    expect(secondResult[0].value).toBe(5);
  });
});

describe('enableSyncServer — pull-from-aborted-batch must not write into SAB', () => {
  // Architectural race surfaced during validation: a stale `pull` for
  // an aborted batch would race against the new batch's request bytes
  // in the data SAB. The fix gates `writeNextResponseChunk(seq)` by
  // `activeBatch.seq === seq`. Full multi-chunk-response timing race
  // is hard to reproduce deterministically across the Node worker
  // boundary; this test exercises the adjacent structural property
  // — a sequence of independent batches each gets the right response
  // — which a missing or over-restrictive gate would break.
  let harness: NodeTestHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.terminate();
    harness = undefined;
  });

  it('five back-to-back single-call batches each return their own value', async () => {
    const {harness: h, rpc: _rpc} = await createTransportHarness({
      echo<T>(v: T) {
        return v;
      },
    });
    harness = h;

    for (let i = 0; i < 5; i++) {
      const result = (await harness.client.evaluate(
        `(i) => {
          return globalThis._transport.wait(
            [{type: 'call', id: 1000000 + i, method: 'echo', params: [i]}],
            {timeoutMs: 1000}
          );
        }`,
        i,
      )) as any[];
      expect(result[0].value).toBe(i);
    }
  });
});

/**
 * Browser integration test for sync RPC: main thread hosts the `RPC`,
 * a same-origin DedicatedWorker is the sync caller. Validates that the
 * protocol we proved in Node `worker_threads` survives the browser's
 * real SAB + Atomics + postMessage + structured-clone semantics, with
 * COOP `same-origin` + COEP `require-corp` headers in place.
 *
 * Uses `playwright` directly (no `@playwright/test` runner, no
 * `playwright.config.ts`); the vitest runner manages lifecycle.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Browser} from 'playwright';
import {SyncRpcWorkerClient} from './browser-harness/SyncRpcWorkerClient.ts';

describe('sync RPC main↔worker (browser)', () => {
  let browser: Browser;

  beforeAll(async () => {
    const {chromium} = await import('playwright');
    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('rpc.wait([rpc.root.add(a, b)]) round-trips with arguments', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcWorkerClient.create(page);
    await h.expose({add: (a: number, b: number) => a + b});

    const sum = await h.workerEvaluate(
      (client) => client.wait([client.root.add(3, 4)])[0],
    );
    expect(sum).toBe(7);

    await page.close();
  }, 30_000);

  it('rpc.wait round-trips a string return', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcWorkerClient.create(page);
    await h.expose({greet: (name: string) => `hi ${name}`});

    const greeting = await h.workerEvaluate(
      (client) => client.wait([client.root.greet('world')])[0],
    );
    expect(greeting).toBe('hi world');

    await page.close();
  }, 30_000);

  it('client.canWait() returns true in the worker', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcWorkerClient.create(page);

    const value = await h.workerEvaluate((client) => client.canWait());
    expect(value).toBe(true);

    await page.close();
  }, 30_000);

  it('rpc.wait([a, b, c]) batches three calls in one SAB round-trip', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcWorkerClient.create(page);
    await h.expose({
      add: (a: number, b: number) => a + b,
      greet: (name: string) => `hi ${name}`,
      answer: () => 42,
    });

    const results = await h.workerEvaluate((client) =>
      client.wait([
        client.root.add(3, 4),
        client.root.greet('world'),
        client.root.answer(),
      ]),
    );
    expect(results).toEqual([7, 'hi world', 42]);

    await page.close();
  }, 30_000);

  it('rpc.wait settles every promise in the batch even when one errors', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcWorkerClient.create(page);
    await h.expose({
      ok: (n: number) => n * 10,
      boom: () => {
        throw new Error('boom');
      },
    });

    // Place the error at index 1 of 3. Without the settle-all-before-throw
    // fix, the call at index 2 stays claimed-but-unsettled — awaiting it
    // hangs forever.
    const outcome = await h.workerEvaluate(async (client) => {
      const a = client.root.ok(1);
      const b = client.root.boom();
      const c = client.root.ok(3);
      let threw = false;
      try {
        client.wait([a, b, c]);
      } catch {
        threw = true;
      }
      // a and c must have been settled by `wait` — awaiting them should
      // resolve synchronously (within the next microtask).
      const aValue = await a;
      const cValue = await c;
      // b should reject.
      let bMessage: string | null = null;
      try {
        await b;
      } catch (err) {
        bMessage = (err as Error).message;
      }
      return {threw, aValue, cValue, bMessage};
    });
    expect(outcome).toEqual({
      threw: true,
      aValue: 10,
      cValue: 30,
      bMessage: 'boom',
    });

    await page.close();
  }, 30_000);

  it('rpc.wait round-trips a multi-chunk request AND multi-chunk response', async () => {
    // Tiny SAB so we provably exercise the multi-chunk path in both
    // directions — a 5 KB payload through a 1 KB SAB chunks ~5 times.
    const page = await browser.newPage();
    const h = await SyncRpcWorkerClient.create(page, {dataSabSize: 1024});
    await h.expose({echo: (s: string) => s});

    const payload = 'q'.repeat(5000);
    const result = await h.workerEvaluate(
      (client, arg) => client.wait([client.root.echo(arg)])[0] as string,
      payload,
    );
    expect(result.length).toBe(5000);
    expect(result).toBe(payload);

    await page.close();
  }, 30_000);

  it('rpc.wait surfaces a server-side error from one of the batched calls', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcWorkerClient.create(page);
    await h.expose({
      ok: () => 'fine',
      boom: () => {
        throw new Error('kaboom');
      },
    });

    const outcome = await h.workerEvaluate((client) => {
      try {
        client.wait([client.root.ok(), client.root.boom()]);
        return {threw: false};
      } catch (err) {
        return {threw: true, message: (err as Error).message};
      }
    });
    expect(outcome).toEqual({threw: true, message: 'kaboom'});

    await page.close();
  }, 30_000);
});

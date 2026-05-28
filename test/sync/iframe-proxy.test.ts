/**
 * Cross-origin iframe-proxy topology test for sync RPC.
 *
 * The killer test of direction C from `findings.md`: keep the SAB
 * inside the same-origin iframe ↔ worker pair, use plain async
 * postMessage for the cross-origin parent ↔ iframe hop. The worker
 * still sees a synchronous `rpc.wait(...)` (blocks in `Atomics.wait`);
 * the host on the parent thread sees only async calls.
 *
 * This is the topology that should actually work in production for
 * cross-origin extension sandboxes (host page + iframe at different
 * origins), since the design.md §6 SAB-through-iframe topology
 * fundamentally can't (per the cross-origin SAB finding documented
 * in `iframe.test.ts`).
 *
 * Origins are HTTPS so the parent is a proper secure context; the
 * Playwright context uses `ignoreHTTPSErrors: true` so we can intercept
 * via `page.route` without setting up a real TLS server.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Browser, BrowserContext} from 'playwright';
import {SyncRpcProxyIframeWorkerClient} from './browser-harness/SyncRpcProxyIframeWorkerClient.ts';

describe('sync RPC proxy iframe (cross-origin parent ↔ broker iframe ↔ worker)', () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    const {chromium} = await import('playwright');
    browser = await chromium.launch();
    context = await browser.newContext({ignoreHTTPSErrors: true});
  }, 30_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  it('rpc.wait round-trips a primitive across the cross-origin iframe broker', async () => {
    const h = await SyncRpcProxyIframeWorkerClient.create(context);
    await h.expose({add: (a: number, b: number) => a + b});

    const sum = await h.workerEvaluate(
      (client) => client.wait([client.root.add(3, 4)])[0],
    );
    expect(sum).toBe(7);

    await h.page.close();
  }, 30_000);

  it('rpc.wait round-trips an N-arity batch across the cross-origin iframe broker', async () => {
    const h = await SyncRpcProxyIframeWorkerClient.create(context);
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

    await h.page.close();
  }, 30_000);

  it('rpc.wait round-trips multi-chunk both directions across the cross-origin iframe broker', async () => {
    const h = await SyncRpcProxyIframeWorkerClient.create(context, {
      dataSabSize: 1024,
    });
    await h.expose({echo: (s: string) => s});

    const payload = 'q'.repeat(5000);
    const result = await h.workerEvaluate(
      (client, arg) => client.wait([client.root.echo(arg)])[0] as string,
      payload,
    );
    expect(result).toBe(payload);

    await h.page.close();
  }, 30_000);
});

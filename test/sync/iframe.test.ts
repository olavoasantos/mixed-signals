/**
 * Iframe topology test for sync RPC: parent ↔ iframe-relay ↔ worker.
 *
 * Validates that the protocol survives the iframe-forwarder hop in a
 * real browser. The iframe is a dumb postMessage pipe — only the leaf
 * worker calls `Atomics.wait`; everyone else is event-loop driven.
 *
 * ---
 *
 * **CRITICAL design finding** (this slice):
 *
 * design.md §6 describes a cross-origin iframe topology (parent at
 * one origin hosting an iframe from a different origin, which spawns
 * a worker). The §6 "SAB transfer — verification required" open
 * question asks whether this works on shipping browsers.
 *
 * **Answer: it does not.** Empirically validated in Chromium 148:
 *
 *   - `crossOriginIsolated` enables, by spec, an "origin-keyed agent
 *     cluster". Each origin is its own cluster.
 *   - `SharedArrayBuffer` is bound to its allocating agent cluster.
 *   - `postMessage` carrying a SAB between different agent clusters
 *     (i.e. different origins under COI) is silently dropped — the
 *     receiving `message` event never fires (the message containing
 *     the SAB is discarded entirely). Plain (no-SAB) messages still
 *     pass.
 *   - This is true even with `allow="cross-origin-isolated"` on the
 *     iframe, COOP `same-origin` + COEP `require-corp` on both ends,
 *     and `Cross-Origin-Resource-Policy: cross-origin` everywhere.
 *
 * **Implication:** the cross-eTLD+1 iframe topology in design.md §6 is
 * unrealizable with SABs under current browser implementations. Any
 * actual deployment must either (a) co-locate the extension on the
 * same origin as the host (defeats isolation), (b) use a non-SAB
 * mechanism, or (c) build a same-origin worker-broker that the
 * cross-origin iframe communicates with via plain postMessage.
 *
 * This test therefore uses a **same-origin** iframe (different path,
 * same origin) to validate the relay code path. That's the only
 * iframe topology that actually works for SAB transfer.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Browser} from 'playwright';
import {SyncRpcIframeWorkerClient} from './browser-harness/SyncRpcIframeWorkerClient.ts';

// Use a port distinct from `browser.test.ts` so the two files can run in
// parallel without their `page.route` patterns colliding on the same
// hostname:port. Both still qualify as secure contexts (loopback).
const ORIGIN = 'http://localhost:18081';

describe('sync RPC iframe (same-origin parent ↔ iframe-relay ↔ worker)', () => {
  let browser: Browser;

  beforeAll(async () => {
    const {chromium} = await import('playwright');
    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('rpc.wait round-trips a primitive across the iframe chain', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcIframeWorkerClient.create(page, {origin: ORIGIN});
    await h.expose({add: (a: number, b: number) => a + b});

    const sum = await h.workerEvaluate(
      (client) => client.wait([client.root.add(3, 4)])[0],
    );
    expect(sum).toBe(7);

    await page.close();
  }, 30_000);

  it('rpc.wait round-trips an N-arity batch across the iframe chain', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcIframeWorkerClient.create(page, {origin: ORIGIN});
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

  it('rpc.wait round-trips multi-chunk request + response across the iframe chain', async () => {
    const page = await browser.newPage();
    const h = await SyncRpcIframeWorkerClient.create(page, {
      origin: ORIGIN,
      dataSabSize: 1024,
    });
    await h.expose({echo: (s: string) => s});

    const payload = 'w'.repeat(5000);
    const result = await h.workerEvaluate(
      (client, arg) => client.wait([client.root.echo(arg)])[0] as string,
      payload,
    );
    expect(result).toBe(payload);

    await page.close();
  }, 30_000);

  /**
   * Documents the cross-origin SAB-transfer failure observed during this
   * spike. Kept as an active probe (not skipped) so any future fix to
   * Chromium's behavior — or a different browser — surfaces as a
   * passing test instead of a silent capability.
   *
   * Currently asserts the FAILURE behavior: a SAB posted from a COI
   * parent to a cross-origin (different eTLD+1) COI iframe is silently
   * dropped (the receiving `message` listener never fires for that
   * specific payload, even though plain messages still flow).
   */
  it('cross-eTLD+1 SAB postMessage is silently dropped (spec: origin-keyed agent clusters)', async () => {
    const {chromium} = await import('playwright');
    const xBrowser = await chromium.launch({
      args: [
        '--unsafely-treat-insecure-origin-as-secure=http://shop.test,http://ext.test',
      ],
    });
    try {
      const page = await xBrowser.newPage();
      const headers = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      };
      await page.route('http://shop.test/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers,
          body: `<!DOCTYPE html><html><body>
            <iframe id="f" allow="cross-origin-isolated" src="http://ext.test/"></iframe>
            <script>
              const f = document.getElementById('f');
              window.__received = [];
              window.addEventListener('message', (e) => {
                window.__received.push({origin: e.origin, payload: e.data && Object.keys(e.data)});
              });
              f.addEventListener('load', () => {
                // Plain (no SAB) post — should be delivered.
                f.contentWindow.postMessage({kind: 'plain'}, 'http://ext.test');
                // Post containing a SAB — should be silently dropped.
                const sab = new SharedArrayBuffer(16);
                f.contentWindow.postMessage({kind: 'withSab', sab}, 'http://ext.test');
              });
            </script>
          </body></html>`,
        });
      });
      await page.route('http://ext.test/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers,
          body: `<!DOCTYPE html><html><body><script>
            window.__received = [];
            window.addEventListener('message', (e) => {
              window.__received.push({
                kind: e.data?.kind,
                hasSab: e.data?.sab instanceof SharedArrayBuffer,
              });
              parent.postMessage({
                __probe__: 'iframe-received',
                snapshot: window.__received,
              }, 'http://shop.test');
            });
          </script></body></html>`,
        });
      });
      await page.goto('http://shop.test/');
      // Give the page time to receive both posts (if delivered).
      await page.waitForTimeout(500);
      const iframeReceived = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              __received: Array<{origin: string; payload: unknown}>;
            }
          ).__received,
      );
      // Iframe's `__received` (snapshot via parent): only the plain post.
      const probeMessages = iframeReceived.filter(
        (m) =>
          m.payload != null &&
          (m.payload as string[]).includes('__probe__'),
      );
      // Each probe message snapshot reflects what the iframe has seen so far.
      // We expect AT LEAST one probe (for the plain post) but NEVER a snapshot
      // that includes `hasSab: true` — because the SAB payload's `message`
      // event never fires in the iframe.
      const lastProbe = probeMessages[probeMessages.length - 1] as unknown as {
        payload: string[];
      } | undefined;
      expect(lastProbe, 'iframe should receive the plain (no-SAB) post').toBeDefined();
      // The full snapshot is what we actually care about. Re-fetch via
      // page.evaluate inside the iframe context to read its `__received`.
      const iframeSnapshot = await page
        .frames()
        .find((f) => f.url() === 'http://ext.test/')
        ?.evaluate(
          () =>
            (
              globalThis as unknown as {
                __received: Array<{kind: string; hasSab: boolean}>;
              }
            ).__received,
        );
      expect(
        iframeSnapshot,
        'iframe should have received the plain post but NOT the SAB post',
      ).toEqual([{kind: 'plain', hasSab: false}]);
    } finally {
      await xBrowser.close();
    }
  }, 30_000);
});

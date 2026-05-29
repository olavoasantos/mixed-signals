/**
 * Tunneled-MessagePort spike.
 *
 * Validates a transport pattern proposed during design discussion: the
 * cross-origin iframe broker's upstream channel to the parent can be a
 * `MessagePort` that the parent transfers via the worker at handshake,
 * rather than `window.parent.postMessage`.
 *
 * Topology under test (cross-origin):
 *
 *   parent (https://parent.test)
 *     creates MessageChannel  →  hostPort, brokerPort
 *     iframe.contentWindow.postMessage({type: 'tunnel-init'},
 *                                       iframeOrigin,
 *                                       [brokerPort])
 *
 *   iframe (https://child.test)  — receives brokerPort, immediately
 *                                   forwards to worker:
 *     worker.postMessage({type: 'tunnel-init'}, [brokerPort])
 *
 *   worker (same-origin to iframe) — receives brokerPort, immediately
 *                                     re-transfers back to iframe:
 *     self.postMessage({type: 'tunneled-port'}, [brokerPort])
 *
 *   iframe — receives brokerPort back; now holds a direct port to host.
 *            iframe ↕ port ↕ host  (cross-origin, but not via
 *                                    window.parent.postMessage)
 *
 * The point: the port handle's provenance traces through the worker
 * bootstrap, inheriting the same trust chain. Runtime messages bypass
 * the worker entirely — traffic flows iframe ↔ parent directly, so
 * the worker can be sync-blocked in `Atomics.wait` without gating the
 * channel.
 *
 * This file is the isolated mechanism test: prove the round trip and
 * the resulting port handle works for bidirectional comms. The full
 * sync-RPC integration is in `iframe-tunneled-broker.test.ts`.
 *
 * Assertion: a round-trip ping/pong over the tunneled port succeeds
 * AND the port arrived via the worker (verifies the trip happened,
 * not a direct transfer).
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Browser, BrowserContext} from 'playwright';

const PARENT_ORIGIN = 'https://parent.test';
const IFRAME_ORIGIN = 'https://child.test';

const COI_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

describe('tunneled MessagePort across cross-origin iframe + same-origin worker', () => {
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

  it('host → iframe → worker → iframe round trip yields a working port', async () => {
    const page = await context.newPage();
    try {
      // Worker source — re-transfers the inbound port back to its
      // creator (the iframe) via `self.postMessage([port])`.
      const workerSource = `
        const trail = [];
        self.addEventListener('message', (e) => {
          trail.push({
            type: e.data?.type,
            portCount: e.ports.length,
          });
          if (e.data?.type === 'tunnel-init' && e.ports[0]) {
            // Re-transfer back to the iframe. Same-origin transfer;
            // we know this works. The point: by the time the port
            // surfaces in the iframe, it has visibly traversed the
            // worker (which the host trusted via its bootstrap).
            self.postMessage(
              {type: 'tunneled-port', trail},
              [e.ports[0]],
            );
          }
        });
      `;

      await page.route(`${IFRAME_ORIGIN}/**`, (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: COI_HEADERS,
          body: `<!DOCTYPE html><html><body><script>
            (globalThis).__diag = {workerTrail: null, gotPortBack: false};

            const PARENT = '${PARENT_ORIGIN}';
            const blob = new Blob([${JSON.stringify(workerSource)}],
              {type: 'application/javascript'});
            const workerUrl = URL.createObjectURL(blob);
            const worker = new Worker(workerUrl);

            window.addEventListener('message', (event) => {
              if (event.origin !== PARENT) return;
              if (event.data?.type !== 'tunnel-init') return;
              const port = event.ports[0];
              if (!port) return;
              // Forward to worker for the trust-establishing re-transfer.
              worker.postMessage({type: 'tunnel-init'}, [port]);
            });

            worker.addEventListener('message', (e) => {
              if (e.data?.type !== 'tunneled-port' || !e.ports[0]) return;
              (globalThis).__diag.workerTrail = e.data.trail;
              (globalThis).__diag.gotPortBack = true;
              const port = e.ports[0];

              // Wire up the tunneled port. The iframe now has a
              // direct MessagePort channel to the host.
              port.addEventListener('message', (msg) => {
                if (msg.data === 'ping') {
                  port.postMessage('pong');
                }
              });
              port.start();

              // Tell parent we are ready (via the port itself).
              port.postMessage('iframe-ready');
            });
          </script></body></html>`,
        });
      });

      await page.route(`${PARENT_ORIGIN}/**`, (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: COI_HEADERS,
          body: `<!DOCTYPE html><html><body>
            <iframe id="f" allow="cross-origin-isolated"
                    src="${IFRAME_ORIGIN}/"></iframe>
            <script>
              (globalThis).__events = [];
              (globalThis).__result = new Promise((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error('tunnel handshake timed out')),
                  5000,
                );
                const channel = new MessageChannel();
                const hostPort = channel.port1;
                const brokerPort = channel.port2;

                hostPort.addEventListener('message', (e) => {
                  (globalThis).__events.push({kind: 'recv', data: e.data});
                  if (e.data === 'iframe-ready') {
                    // Step 2: send a ping; expect pong.
                    hostPort.postMessage('ping');
                  } else if (e.data === 'pong') {
                    clearTimeout(timeout);
                    resolve({ok: true, events: (globalThis).__events});
                  }
                });
                hostPort.start();

                const f = document.getElementById('f');
                f.addEventListener('load', () => {
                  f.contentWindow.postMessage(
                    {type: 'tunnel-init'},
                    '${IFRAME_ORIGIN}',
                    [brokerPort],
                  );
                });
              });
            </script>
          </body></html>`,
        });
      });

      await page.goto(`${PARENT_ORIGIN}/`);

      const result = await page.evaluate(() =>
        (
          globalThis as unknown as {
            __result: Promise<{
              ok: boolean;
              events: Array<{kind: string; data: unknown}>;
            }>;
          }
        ).__result,
      );

      const iframe = page.frames().find((f) => f.url() === `${IFRAME_ORIGIN}/`);
      const iframeDiag = await iframe!.evaluate(
        () =>
          (
            globalThis as unknown as {
              __diag: {
                workerTrail:
                  | Array<{type: string; portCount: number}>
                  | null;
                gotPortBack: boolean;
              };
            }
          ).__diag,
      );

      expect(result.ok).toBe(true);
      expect(result.events.map((e) => e.data)).toEqual([
        'iframe-ready',
        'pong',
      ]);
      // Confirm the port actually went through the worker (vs being
      // forwarded directly iframe → iframe and bypassing the trust
      // chain).
      expect(iframeDiag.gotPortBack).toBe(true);
      expect(iframeDiag.workerTrail).toEqual([
        {type: 'tunnel-init', portCount: 1},
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);
});

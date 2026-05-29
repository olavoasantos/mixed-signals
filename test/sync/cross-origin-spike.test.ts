/**
 * Cross-origin SAB transfer spike.
 *
 * Our existing `iframe.test.ts` failure case tested cross-eTLD+1 SAB
 * postMessage with:
 *   - COOP `same-origin` + COEP `require-corp` + CORP `cross-origin`
 *   - `allow="cross-origin-isolated"` on the iframe element
 *
 * A hypothesis raised in design review was that the missing piece is
 * `Permissions-Policy: cross-origin-isolated=(self "<other>")`
 * delegation on both responses — i.e. that explicit COI delegation
 * unlocks cross-cluster SAB transfer that the spec text alone seems
 * to forbid.
 *
 * **Result (Chromium 148 headless + headed, Chrome 147 headless + headed,
 * macOS, May 2026):** the hypothesis is falsified. With the full
 * Permissions-Policy delegation and `*.localhost` origins (which
 * Chromium auto-treats as secure), the SAB-bearing postMessage from a
 * COI parent to a cross-origin COI iframe still does not deliver. The
 * receiver fires a `messageerror` event (which our earlier prototype
 * test missed because it only listened for `message`). The data path
 * is broken regardless of Permissions-Policy. The active-broker
 * topology (SAB inside same-origin iframe ↔ worker pair) remains the
 * only working option for cross-origin extension sandboxes.
 *
 * Subtlety worth noting: a setup like this one appears "to run" — the
 * pages load, `crossOriginIsolated === true`, the parent logs
 * "transferred port + SABs to iframe". But the iframe never receives
 * the message; nothing downstream fires. Without a `messageerror`
 * handler on the iframe side, the failure is invisible unless you
 * check whether the next step in the protocol actually fires.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Browser} from 'playwright';

// `*.localhost` is auto-treated as a secure context by Chromium — no
// `--unsafely-treat-insecure-origin-as-secure` flag needed. Both
// origins become COI through COOP/COEP plus the Permissions-Policy
// delegation below.
const PARENT_ORIGIN = 'http://parent.localhost:14173';
const IFRAME_ORIGIN = 'http://child.localhost:14173';

/**
 * Full COI header set including `Permissions-Policy: cross-origin-
 * isolated=(self "<other>")` on both responses. The novel piece vs
 * the existing `iframe.test.ts` failure test is the
 * `Permissions-Policy` line.
 */
const COI_HEADERS_WITH_DELEGATION: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Permissions-Policy': `cross-origin-isolated=(self "${PARENT_ORIGIN}" "${IFRAME_ORIGIN}")`,
};

describe('cross-origin SAB transfer (Permissions-Policy delegation hypothesis)', () => {
  let browser: Browser;

  beforeAll(async () => {
    const {chromium} = await import('playwright');
    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * Stage 1: bare SAB postMessage parent → cross-origin iframe, with the
   * full Permissions-Policy delegation. Asserts that the SAB-bearing
   * message is rejected: the iframe's `message` listener does NOT fire,
   * but a `messageerror` event DOES.
   */
  it('Stage 1: parent → cross-origin iframe SAB postMessage fires messageerror despite PP delegation', async () => {
    const page = await browser.newPage();
    try {
      await page.route(`${IFRAME_ORIGIN}/**`, (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: COI_HEADERS_WITH_DELEGATION,
          body: `<!DOCTYPE html><html><body><script>
            (globalThis).__coi = crossOriginIsolated;
            (globalThis).__received = [];
            (globalThis).__messageErrors = 0;
            window.addEventListener('message', (e) => {
              (globalThis).__received.push({
                kind: e.data?.kind,
                hasSab: e.data?.sab instanceof SharedArrayBuffer,
              });
            });
            window.addEventListener('messageerror', () => {
              (globalThis).__messageErrors += 1;
            });
          </script></body></html>`,
        });
      });
      await page.route(`${PARENT_ORIGIN}/**`, (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: COI_HEADERS_WITH_DELEGATION,
          body: `<!DOCTYPE html><html><body>
            <iframe id="f" allow="cross-origin-isolated" src="${IFRAME_ORIGIN}/"></iframe>
            <script>
              (globalThis).__coi = crossOriginIsolated;
              const f = document.getElementById('f');
              f.addEventListener('load', () => {
                f.contentWindow.postMessage({kind: 'plain'}, '${IFRAME_ORIGIN}');
                const sab = new SharedArrayBuffer(16);
                f.contentWindow.postMessage({kind: 'withSab', sab}, '${IFRAME_ORIGIN}');
              });
            </script>
          </body></html>`,
        });
      });
      await page.goto(`${PARENT_ORIGIN}/`);
      await page.waitForTimeout(500);

      const parentCoi = await page.evaluate(
        () => (globalThis as unknown as {__coi: boolean}).__coi,
      );
      const iframe = page.frames().find((f) => f.url() === `${IFRAME_ORIGIN}/`);
      expect(iframe, 'iframe frame should exist').toBeDefined();

      const iframeDiag = await iframe!.evaluate(() => ({
        coi: (globalThis as unknown as {__coi: boolean}).__coi,
        received: (
          globalThis as unknown as {
            __received: Array<{kind: string; hasSab: boolean}>;
          }
        ).__received,
        messageErrors: (
          globalThis as unknown as {__messageErrors: number}
        ).__messageErrors,
      }));

      // Sanity: COI is on, on both sides. Confirms the PP delegation worked
      // for COI status; the SAB-transfer failure is NOT a COI-isn't-on bug.
      expect(parentCoi, 'parent must be crossOriginIsolated').toBe(true);
      expect(iframeDiag.coi, 'iframe must be crossOriginIsolated').toBe(true);

      // The actual finding: plain post lands, SAB post fires messageerror.
      expect(iframeDiag.received).toEqual([{kind: 'plain', hasSab: false}]);
      expect(iframeDiag.messageErrors).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  /**
   * Stage 2 (consequence): the full parent → iframe → Blob-worker
   * chain hangs because the iframe never receives the SAB-bearing
   * message. Documents the silent-from-the-parent's-perspective
   * failure mode that follows directly from Stage 1.
   */
  it('Stage 2: end-to-end chain hangs — iframe never receives SAB, worker is never created', async () => {
    const page = await browser.newPage();
    try {
      await page.route(`${IFRAME_ORIGIN}/**`, (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: COI_HEADERS_WITH_DELEGATION,
          body: `<!DOCTYPE html><html><body><script>
            (globalThis).__workerSpawned = false;
            window.addEventListener('message', (event) => {
              if (event.data?.type !== 'rpc-bootstrap') return;
              const {control, data} = event.data;
              const workerSrc = 'self.postMessage({type: \\'init\\'});';
              const blob = new Blob([workerSrc], {type: 'text/javascript'});
              const url = URL.createObjectURL(blob);
              const w = new Worker(url, {name: 'spike-blob-worker'});
              (globalThis).__workerSpawned = true;
              w.addEventListener('message', () => {
                parent.postMessage({type: 'worker-ready'}, '${PARENT_ORIGIN}');
              });
            });
          </script></body></html>`,
        });
      });
      await page.route(`${PARENT_ORIGIN}/**`, (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: COI_HEADERS_WITH_DELEGATION,
          body: `<!DOCTYPE html><html><body>
            <iframe id="f" allow="cross-origin-isolated" src="${IFRAME_ORIGIN}/"></iframe>
            <script>
              (globalThis).__workerReady = false;
              window.addEventListener('message', (e) => {
                if (e.origin !== '${IFRAME_ORIGIN}') return;
                if (e.data?.type === 'worker-ready') (globalThis).__workerReady = true;
              });
              document.getElementById('f').addEventListener('load', () => {
                const control = new SharedArrayBuffer(4);
                const data = new SharedArrayBuffer(64);
                document.getElementById('f').contentWindow.postMessage(
                  {type: 'rpc-bootstrap', control, data},
                  '${IFRAME_ORIGIN}',
                );
              });
            </script>
          </body></html>`,
        });
      });
      await page.goto(`${PARENT_ORIGIN}/`);
      // Give the chain ample time to execute if it can.
      await page.waitForTimeout(1500);

      const parentReady = await page.evaluate(
        () =>
          (globalThis as unknown as {__workerReady: boolean}).__workerReady,
      );
      const iframe = page.frames().find((f) => f.url() === `${IFRAME_ORIGIN}/`);
      const iframeSpawned = await iframe!.evaluate(
        () =>
          (globalThis as unknown as {__workerSpawned: boolean})
            .__workerSpawned,
      );

      // The full chain breaks at step 1 — iframe never received the
      // SAB-bearing message, so the worker was never created.
      expect(
        iframeSpawned,
        'iframe should NOT have spawned a worker (it never received the SAB-bearing postMessage)',
      ).toBe(false);
      expect(parentReady, 'parent should NOT see worker-ready').toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);
});

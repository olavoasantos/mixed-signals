/**
 * Cross-origin iframe broker bench (Playwright-based).
 *
 * Measures the cross-origin postMessage round-trip latency that
 * dominates the §6.2 broker topology. Target per §10: ~100-200 µs
 * for the full broker chain.
 *
 * Note: this bench measures the cross-origin postMessage hop only,
 * not the full worker → SAB → broker → parent → broker → SAB →
 * worker chain. The full broker bench requires
 * MixedSignalsBrowserHarness with sync support, which is deferred.
 * The postMessage RTT is the dominant variable cost in the broker
 * topology — the SAB + Atomics legs are covered by Node benches.
 *
 * Requires Playwright browsers: `npx playwright install chromium`.
 * Skipped if Playwright is not available or browsers aren't installed.
 */
import {bench, describe, afterAll, beforeAll} from 'vitest';

let available = true;
let chromium: any;

try {
  const pw = await import('@playwright/test');
  chromium = pw.chromium;
} catch {
  available = false;
}

let browser: any;
let page: any;

beforeAll(async () => {
  if (!available) return;

  try {
    browser = await chromium.launch({headless: true});
  } catch {
    // Browsers not installed — skip gracefully
    available = false;
    return;
  }

  const context = await browser.newContext();
  page = await context.newPage();

  const hostOrigin = 'https://host.test';
  const extOrigin = 'https://ext.test';

  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url());
    const headers: Record<string, string> = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    };

    if (url.origin === hostOrigin && url.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers,
        body: `<!DOCTYPE html><html><body>
<iframe id="ext" src="${extOrigin}/" allow="cross-origin-isolated" crossorigin></iframe>
<script>
  window.__ready = new Promise(resolve => {
    window.addEventListener('message', function onReady(ev) {
      if (ev.data && ev.data.type === 'iframe-ready') {
        window.removeEventListener('message', onReady);
        resolve();
      }
    });
  });
</script>
</body></html>`,
      });
    } else if (url.origin === extOrigin && url.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers,
        body: `<!DOCTYPE html><html><body>
<script>
  window.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'ping') {
      ev.source.postMessage({ type: 'pong', seq: ev.data.seq }, ev.origin);
    }
  });
  window.parent.postMessage({ type: 'iframe-ready' }, '*');
</script>
</body></html>`,
      });
    } else {
      await route.fulfill({status: 404, body: 'Not found'});
    }
  });

  await page.goto(hostOrigin + '/');
  await page.evaluate(() => (window as any).__ready);
});

afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!available)('sync-rpc cross-origin postmessage', () => {
  bench(
    'cross_origin_postmessage_rtt',
    async () => {
      // Run N round-trips inside the browser to amortize
      // Playwright evaluate() overhead.
      await page.evaluate(() => {
        const iframe = document.getElementById('ext') as HTMLIFrameElement;
        const N = 50;
        return new Promise<number>((done) => {
          let completed = 0;
          const start = performance.now();

          function next(seq: number) {
            iframe.contentWindow!.postMessage(
              {type: 'ping', seq},
              'https://ext.test',
            );
          }

          const handler = (ev: MessageEvent) => {
            if (ev.data?.type !== 'pong') return;
            completed++;
            if (completed >= N) {
              window.removeEventListener('message', handler);
              done(((performance.now() - start) * 1000) / N);
            } else {
              next(completed);
            }
          };
          window.addEventListener('message', handler);
          next(0);
        });
      });
    },
    {iterations: 50, warmupIterations: 10},
  );
});

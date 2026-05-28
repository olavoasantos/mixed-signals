/**
 * Test harness for the cross-origin iframe-proxy sync RPC topology.
 *
 * Topology:
 *
 *   parent page (parentOrigin)           — RPC host, plain JS, no SABs
 *     ↕ async postMessage (cross-origin)
 *   iframe (iframeOrigin)                — broker, owns SABs
 *     ↕ SAB + Atomics + postMessage (same-origin)
 *   worker (spawned by iframe)           — RPCClient, blocks in wait
 *
 * Validates the user's insight that, since SAB transfer is bound to
 * the agent cluster, we keep the SAB within the same-origin iframe ↔
 * worker pair. The cross-origin parent ↔ iframe hop is plain async
 * postMessage (no SABs, no agent-cluster constraint).
 *
 * Origins use HTTPS (with `ignoreHTTPSErrors: true` on the context) so
 * the parent is a proper secure context — `crypto.randomUUID` works,
 * `crossOriginIsolated` is true, no flag-acrobatics needed.
 */
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {BrowserContext, Page} from 'playwright';
import type {RPCClient} from '../../../client/rpc.ts';
import {bundleForBrowser} from './bundleForBrowser.ts';

const ENTRIES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'entries');
const PARENT_ENTRY = resolve(ENTRIES_DIR, 'proxy-parent.ts');
const IFRAME_ENTRY = resolve(ENTRIES_DIR, 'proxy-iframe.ts');
const WORKER_ENTRY = resolve(ENTRIES_DIR, 'worker.ts');

let bundlesPromise: Promise<{
  parent: string;
  iframe: string;
  worker: string;
}> | null = null;
function getBundles(): Promise<{
  parent: string;
  iframe: string;
  worker: string;
}> {
  if (!bundlesPromise) {
    bundlesPromise = Promise.all([
      bundleForBrowser(PARENT_ENTRY),
      bundleForBrowser(IFRAME_ENTRY),
      bundleForBrowser(WORKER_ENTRY),
    ]).then(([parent, iframe, worker]) => ({parent, iframe, worker}));
  }
  return bundlesPromise;
}

const COI_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export interface SyncRpcProxyIframeWorkerClientOptions {
  /** Parent (admin) origin. Default `https://shop.test`. */
  parentOrigin?: string;
  /** Iframe (extension CDN) origin. Default `https://ext.test`. */
  iframeOrigin?: string;
  /** Override the data SAB size on the iframe broker. Default 64 KiB. */
  dataSabSize?: number;
}

export class SyncRpcProxyIframeWorkerClient {
  readonly page: Page;
  readonly parentOrigin: string;
  readonly iframeOrigin: string;

  private constructor(page: Page, parentOrigin: string, iframeOrigin: string) {
    this.page = page;
    this.parentOrigin = parentOrigin;
    this.iframeOrigin = iframeOrigin;
  }

  static async create(
    context: BrowserContext,
    opts: SyncRpcProxyIframeWorkerClientOptions = {},
  ): Promise<SyncRpcProxyIframeWorkerClient> {
    const parentOrigin = opts.parentOrigin ?? 'https://shop.test';
    const iframeOrigin = opts.iframeOrigin ?? 'https://ext.test';
    const {parent, iframe, worker} = await getBundles();

    const page = await context.newPage();
    page.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log('[browser pageerror]', err.message);
    });

    const dataSabPreamble =
      opts.dataSabSize != null
        ? `<script>window.__DATA_SAB_SIZE__ = ${opts.dataSabSize};</script>`
        : '';

    const parentHtml = `<!DOCTYPE html><html><head>
      <meta charset="utf-8" />
      <title>sync-rpc proxy harness — parent</title>
      <script>
        window.__IFRAME_ORIGIN__ = ${JSON.stringify(iframeOrigin)};
        window.__PARENT_ORIGIN__ = ${JSON.stringify(parentOrigin)};
      </script>
      ${dataSabPreamble}
    </head><body>
      <script>${parent}</script>
    </body></html>`;

    const iframeHtml = `<!DOCTYPE html><html><head>
      <meta charset="utf-8" />
      <title>sync-rpc proxy harness — iframe</title>
      <script>
        window.__PARENT_ORIGIN__ = ${JSON.stringify(parentOrigin)};
        window.__WORKER_URL__ = '${iframeOrigin}/worker.js';
      </script>
      ${dataSabPreamble}
    </head><body>
      <script>${iframe}</script>
    </body></html>`;

    // Catch-alls first; specific resources override (Playwright matches
    // routes in reverse registration order).
    await page.route(`${parentOrigin}/**`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: COI_HEADERS,
        body: parentHtml,
      });
    });
    await page.route(`${iframeOrigin}/**`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: COI_HEADERS,
        body: iframeHtml,
      });
    });
    await page.route(`${iframeOrigin}/worker.js`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        headers: COI_HEADERS,
        body: worker,
      });
    });

    await page.goto(parentOrigin);

    const diag = await page.evaluate(() => ({
      coi: (globalThis as unknown as {crossOriginIsolated: boolean})
        .crossOriginIsolated,
      secure: (globalThis as unknown as {isSecureContext: boolean})
        .isSecureContext,
    }));
    if (!diag.coi || !diag.secure) {
      throw new Error(
        `Parent not COI/secure: ${JSON.stringify(diag)}. ` +
          `Origins must be HTTPS (and the context must use ignoreHTTPSErrors).`,
      );
    }

    // Wait for the worker's sync handshake to complete. Ready signal
    // flows worker → iframe → parent via the eval side-channel.
    await page.evaluate(
      ({iframeOrigin: io}) => {
        return new Promise<void>((resolve) => {
          const handler = (e: MessageEvent) => {
            if (e.origin !== io) return;
            if (
              e.data &&
              (e.data as {__type__?: unknown}).__type__ === 'ready'
            ) {
              window.removeEventListener('message', handler);
              resolve();
            }
          };
          window.addEventListener('message', handler);
        });
      },
      {iframeOrigin},
    );

    return new SyncRpcProxyIframeWorkerClient(page, parentOrigin, iframeOrigin);
  }

  /**
   * Publish methods on the host root via `Object.assign` (see the
   * same-origin variant for the rationale).
   */
  async expose(root: Record<string, unknown>): Promise<void> {
    const serialized: Record<
      string,
      {kind: 'fn'; source: string} | {kind: 'value'; value: unknown}
    > = {};
    for (const [key, value] of Object.entries(root)) {
      if (typeof value === 'function') {
        serialized[key] = {kind: 'fn', source: value.toString()};
      } else {
        serialized[key] = {kind: 'value', value};
      }
    }
    await this.page.evaluate((s: typeof serialized) => {
      const built: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(s)) {
        if (entry.kind === 'fn') {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          built[key] = new Function(`return (${entry.source});`)();
        } else {
          built[key] = entry.value;
        }
      }
      const rootObj = (
        globalThis as unknown as {__root__: Record<string, unknown>}
      ).__root__;
      Object.assign(rootObj, built);
    }, serialized);
  }

  /**
   * Run a function inside the worker. Source is shipped via the eval
   * side-channel which flows parent → iframe → worker (and back).
   */
  workerEvaluate<R>(fn: (client: RPCClient) => R | Promise<R>): Promise<R>;
  workerEvaluate<R, A>(
    fn: (client: RPCClient, arg: A) => R | Promise<R>,
    arg: A,
  ): Promise<R>;
  async workerEvaluate(
    fn: (client: RPCClient, arg?: unknown) => unknown,
    arg?: unknown,
  ): Promise<unknown> {
    const code = fn.toString();
    const id = Date.now() + Math.random();
    return this.page.evaluate(
      ({code: c, evalArg, id: i, iframeOrigin: io}) => {
        return new Promise<unknown>((resolve, reject) => {
          const iframe = (
            globalThis as unknown as {__iframe__: HTMLIFrameElement}
          ).__iframe__;
          const handler = (e: MessageEvent) => {
            if (e.origin !== io) return;
            const m = e.data as {
              __type__?: string;
              __id__?: number;
              ok?: boolean;
              value?: unknown;
              error?: string;
            };
            if (m?.__type__ !== 'evalResult' || m.__id__ !== i) return;
            window.removeEventListener('message', handler);
            if (m.ok) resolve(m.value);
            else reject(new Error(m.error ?? 'workerEvaluate error'));
          };
          window.addEventListener('message', handler);
          iframe.contentWindow!.postMessage(
            {__type__: 'eval', __id__: i, code: c, arg: evalArg},
            io,
          );
        });
      },
      {code, evalArg: arg, id, iframeOrigin: this.iframeOrigin},
    );
  }
}

/**
 * Test harness for the cross-origin iframe sync RPC topology.
 *
 * Topology:
 *
 *   parent page (parentOrigin) — RPC host
 *     ↕ postMessage
 *   iframe (iframeOrigin) — relay (postMessage forwarder)
 *     ↕ postMessage
 *   worker (spawned by iframe, same-origin to it) — RPC client + Atomics.wait
 *
 * All three contexts MUST be crossOriginIsolated, which means each
 * response carries COOP `same-origin` + COEP `require-corp` headers.
 * The page-itself origin also has to be a "secure context" — for
 * cross-eTLD+1 hostnames (`shop.test`, `ext.test`), this is achieved
 * via Chromium's `--unsafely-treat-insecure-origin-as-secure=...` flag,
 * which the test passes when launching the browser.
 */
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Page} from 'playwright';
import type {RPCClient} from '../../../client/rpc.ts';
import {bundleForBrowser} from './bundleForBrowser.ts';

const ENTRIES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'entries');
const IFRAME_PARENT_ENTRY = resolve(ENTRIES_DIR, 'iframe-parent.ts');
const IFRAME_ENTRY = resolve(ENTRIES_DIR, 'iframe.ts');
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
      bundleForBrowser(IFRAME_PARENT_ENTRY),
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

export interface SyncRpcIframeWorkerClientOptions {
  /**
   * Origin to serve the parent page from. Must be a secure context
   * (`https:`, `file:`, or `http://localhost*`). Defaults to
   * `http://localhost:18080`.
   *
   * The iframe is served from the SAME origin (at the `/iframe` path).
   * This is **not** an arbitrary choice — cross-origin iframes are in
   * a different agent cluster from the parent (COI implies origin-keyed
   * agent clusters per HTML spec), so SAB transfer across the origin
   * boundary is dropped silently. The iframe relay topology still
   * exercises the parent↔iframe↔worker chain, just within one origin.
   */
  origin?: string;
  /**
   * Override the data SAB size (bytes) on the host. Defaults to the
   * library default (64 KiB).
   */
  dataSabSize?: number;
}

export class SyncRpcIframeWorkerClient {
  readonly page: Page;
  readonly origin: string;

  private constructor(page: Page, origin: string) {
    this.page = page;
    this.origin = origin;
  }

  static async create(
    page: Page,
    opts: SyncRpcIframeWorkerClientOptions = {},
  ): Promise<SyncRpcIframeWorkerClient> {
    const origin = opts.origin ?? 'http://localhost:18080';
    const iframePath = '/iframe';
    const {parent, iframe, worker} = await getBundles();

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
      <title>sync-rpc iframe harness — parent</title>
      <script>
        window.__IFRAME_URL__ = ${JSON.stringify(`${origin}${iframePath}`)};
        window.__ORIGIN__ = ${JSON.stringify(origin)};
      </script>
      ${dataSabPreamble}
    </head><body>
      <script>${parent}</script>
    </body></html>`;

    const iframeHtml = `<!DOCTYPE html><html><head>
      <meta charset="utf-8" />
      <title>sync-rpc iframe harness — iframe</title>
      <script>
        window.__PARENT_ORIGIN__ = ${JSON.stringify(origin)};
        window.__WORKER_URL__ = '${origin}/worker.js';
      </script>
    </head><body>
      <script>${iframe}</script>
    </body></html>`;

    // Routes match in REVERSE registration order — register catch-all
    // first, then specifics override.
    await page.route(`${origin}/**`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: COI_HEADERS,
        body: parentHtml,
      });
    });
    await page.route(`${origin}${iframePath}`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: COI_HEADERS,
        body: iframeHtml,
      });
    });
    await page.route(`${origin}/worker.js`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        headers: COI_HEADERS,
        body: worker,
      });
    });

    await page.goto(origin);

    const diag = await page.evaluate(() => ({
      coi: (globalThis as unknown as {crossOriginIsolated: boolean})
        .crossOriginIsolated,
      secure: (globalThis as unknown as {isSecureContext: boolean})
        .isSecureContext,
      hasSAB: typeof SharedArrayBuffer !== 'undefined',
      origin: location.origin,
    }));
    if (!diag.coi) {
      throw new Error(
        `Parent page is not crossOriginIsolated. Diagnostics: ${JSON.stringify(diag)}`,
      );
    }

    // Wait for the worker's sync handshake to complete. The worker emits
    // `{__type__: 'ready'}` to its parent (the iframe); the relay
    // forwards it up to the parent page where we listen.
    await page.evaluate(({iframeOrigin: io}) => {
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
    }, {iframeOrigin: origin});

    return new SyncRpcIframeWorkerClient(page, origin);
  }

  /**
   * Run a function on the parent page's main thread (host side).
   * `globalThis.rpc` is the `RPC` instance.
   */
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  evaluate(
    fn: (...args: unknown[]) => unknown,
    arg?: unknown,
  ): Promise<unknown> {
    if (arguments.length >= 2) {
      return this.page.evaluate(fn as (a: unknown) => unknown, arg);
    }
    return this.page.evaluate(fn as () => unknown);
  }

  /** Publish methods on the host root via `Object.assign` (see same-origin variant). */
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
   * Run a function INSIDE the worker (the leaf calling `client.wait`).
   * Function source is shipped through the iframe relay; the worker's
   * eval side-channel runs it and ships the result back.
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
          const iframeWindow = iframe.contentWindow as Window;
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
          iframeWindow.postMessage(
            {__type__: 'eval', __id__: i, code: c, arg: evalArg},
            io,
          );
        });
      },
      {code, evalArg: arg, id, iframeOrigin: this.origin},
    );
  }
}

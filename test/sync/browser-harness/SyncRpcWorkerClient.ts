/**
 * Test harness for the sync RPC main↔worker topology.
 *
 * The browser entries are generic infrastructure that expose `rpc` /
 * `client` (and a few helpers) on `globalThis`. Tests drive behavior
 * via `.evaluate(...)` (page main thread) and `.workerEvaluate(...)`
 * (inside the worker), keeping test logic in the spec where it belongs.
 *
 * Usage:
 *
 * ```ts
 * test('rpc.wait round-trips', async () => {
 *   const page = await browser.newPage();
 *   const h = await SyncRpcWorkerClient.create(page);
 *   await h.expose({add: (a: number, b: number) => a + b});
 *   const sum = await h.workerEvaluate((client: any) =>
 *     client.wait([client.root.add(3, 4)])[0],
 *   );
 *   expect(sum).toBe(7);
 *   await page.close();
 * });
 * ```
 */
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Page} from 'playwright';
import type {RPCClient} from '../../../client/rpc.ts';
import {bundleForBrowser} from './bundleForBrowser.ts';

const ENTRIES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'entries');
const PARENT_ENTRY = resolve(ENTRIES_DIR, 'parent.ts');
const WORKER_ENTRY = resolve(ENTRIES_DIR, 'worker.ts');

let bundlesPromise: Promise<{parent: string; worker: string}> | null = null;
function getBundles(): Promise<{parent: string; worker: string}> {
  if (!bundlesPromise) {
    bundlesPromise = Promise.all([
      bundleForBrowser(PARENT_ENTRY),
      bundleForBrowser(WORKER_ENTRY),
    ]).then(([parent, worker]) => ({parent, worker}));
  }
  return bundlesPromise;
}

const COI_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export interface SyncRpcWorkerClientOptions {
  /**
   * Origin to serve the page from. Must be a secure context for
   * `crossOriginIsolated` — `https://*`, `file://*`, or `http://localhost*`.
   * Defaults to `http://localhost:18080`.
   */
  origin?: string;
  /**
   * Override the data SAB size (bytes) on the host. Useful for stressing
   * the chunking protocol in tests without ginormous payloads. Defaults
   * to the library default (64 KiB).
   */
  dataSabSize?: number;
}

export class SyncRpcWorkerClient {
  readonly page: Page;
  private readonly origin: string;

  private constructor(page: Page, origin: string) {
    this.page = page;
    this.origin = origin;
  }

  static async create(
    page: Page,
    opts: SyncRpcWorkerClientOptions = {},
  ): Promise<SyncRpcWorkerClient> {
    const origin = opts.origin ?? 'http://localhost:18080';
    const {parent, worker} = await getBundles();

    // Surface browser-side errors to the Node test output for quick
    // diagnosis. Console logs from passing tests are suppressed by
    // vitest's default reporter; use `--reporter=verbose` to see them.
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
      <title>sync-rpc harness</title>
      <script>window.__WORKER_URL__ = '/worker.js';</script>
      ${dataSabPreamble}
    </head><body>
      <script>${parent}</script>
    </body></html>`;

    // Playwright matches routes in REVERSE registration order — the
    // most-recently-added handler wins. Register the catch-all first so
    // the specific `/worker.js` route can override it.
    await page.route(`${origin}/**`, (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: COI_HEADERS,
        body: parentHtml,
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

    const coi = await page.evaluate(
      () =>
        (globalThis as unknown as {crossOriginIsolated: boolean})
          .crossOriginIsolated,
    );
    if (!coi) {
      throw new Error(
        'Page is not crossOriginIsolated. Check COOP/COEP headers and the origin is a secure context.',
      );
    }

    // Wait for the worker's sync handshake to finish. The worker emits
    // a `{__type__: 'ready'}` message on its postMessage channel; we
    // listen for it inside the page via `__worker__`.
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        const w = (globalThis as unknown as {__worker__: Worker}).__worker__;
        const handler = (e: MessageEvent) => {
          if (
            e.data &&
            (e.data as {__type__?: unknown}).__type__ === 'ready'
          ) {
            w.removeEventListener('message', handler);
            resolve();
          }
        };
        w.addEventListener('message', handler);
      });
    });

    return new SyncRpcWorkerClient(page, origin);
  }

  /**
   * Run a function in the page's main thread context, where
   * `globalThis.rpc` is the host `RPC` instance.
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

  /**
   * Publish methods on the host RPC's root. Functions are passed as
   * their `.toString()` source; tests should keep root methods
   * self-contained (no outer-scope captures).
   *
   * Mutates a stable root object in place via `Object.assign` — see
   * `entries/parent.ts` for the rationale.
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
   * Run a function INSIDE the spawned Worker. The function is shipped
   * as `.toString()` source; it receives `(client, arg)` where
   * `client` is the `RPCClient` instance running inside the worker.
   *
   * The `client: RPCClient` type is for editor DX (autocomplete on
   * `client.root`, `client.wait`, ...). At runtime the worker's
   * `RPCClient` comes from a different module instance (the bundled
   * IIFE), so `instanceof` checks across the boundary won't match —
   * but the shape is identical so all member access works.
   *
   * Functions are stringified via `.toString()` so they CANNOT capture
   * outer-scope variables. Pass anything you need via `arg`.
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
      ({code: c, evalArg, id: i}) => {
        return new Promise<unknown>((resolve, reject) => {
          const w = (globalThis as unknown as {__worker__: Worker}).__worker__;
          const handler = (e: MessageEvent) => {
            const m = e.data as {
              __type__?: string;
              __id__?: number;
              ok?: boolean;
              value?: unknown;
              error?: string;
            };
            if (m?.__type__ !== 'evalResult' || m.__id__ !== i) return;
            w.removeEventListener('message', handler);
            if (m.ok) resolve(m.value);
            else reject(new Error(m.error ?? 'workerEvaluate error'));
          };
          w.addEventListener('message', handler);
          w.postMessage({__type__: 'eval', __id__: i, code: c, arg: evalArg});
        });
      },
      {code, evalArg: arg, id},
    );
  }
}

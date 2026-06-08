import type {
  MessageListener,
  PlaywrightPage,
  PlaywrightFrame,
  TestHarnessEnv,
  WorkerEnvConfig,
} from "../types.ts";
import { bundleEntry, transformForEvaluate } from "../bundle.ts";
import { PortChannel } from "./port-channel.ts";
import { htmlRoutePattern } from "./route-pattern.ts";

/**
 * A TestHarnessEnv backed by an iframe inside a Playwright page.
 */
export class BrowserIframeEnv implements TestHarnessEnv {
  readonly ready: Promise<void>;
  readonly channel: PortChannel;

  private _page: PlaywrightPage;
  private _origin: string;
  private _iframeId: string;
  private _frame: PlaywrightFrame | null = null;
  private _nestedWorkerConfig: WorkerEnvConfig | undefined;

  constructor(
    page: PlaywrightPage,
    entry: string,
    origin: string,
    iframeId: string,
    nestedWorker?: WorkerEnvConfig,
    headers?: Record<string, string>,
  ) {
    this._page = page;
    this._origin = origin;
    this._iframeId = iframeId;
    this._nestedWorkerConfig = nestedWorker;

    this.channel = new PortChannel((data) => {
      void this._deliverToFrame(data);
    });

    this.ready = this._setup(entry, headers ?? {});
  }

  private async _setup(entry: string, headers: Record<string, string>): Promise<void> {
    const code = await bundleEntry(entry);
    let workerScript = "";

    if (this._nestedWorkerConfig) {
      const workerCode = await bundleEntry(this._nestedWorkerConfig.entry);
      const workerUrl = `${this._origin}/worker.js`;
      const workerHeaders = {
        "content-type": "application/javascript",
        "Cross-Origin-Resource-Policy": "cross-origin",
        ...headers,
      };
      await this._page.route(workerUrl, (route) => {
        route.fulfill({ status: 200, body: workerCode, headers: workerHeaders });
      });
      workerScript = `<script>window.__WORKER_URL__="${workerUrl}";</script>`;
    }

    const html = `<!DOCTYPE html><html><head></head><body>
      ${workerScript}
      <script>${code}</script>
    </body></html>`;

    const htmlPattern = htmlRoutePattern(this._origin);
    const routeHeaders = {
      "content-type": "text/html",
      "Cross-Origin-Resource-Policy": "cross-origin",
      ...headers,
    };
    await this._page.route(htmlPattern, (route) => {
      route.fulfill({ status: 200, body: html, headers: routeHeaders });
    });
  }

  _resolveFrame(): void {
    this._frame = this._page.frames().find((f) => f.url().startsWith(this._origin)) ?? null;
  }

  get _iframeOrigin(): string {
    return this._origin;
  }
  get _elementId(): string {
    return this._iframeId;
  }
  get _hasNestedWorker(): boolean {
    return this._nestedWorkerConfig !== undefined;
  }

  async _deliverToFrame(data: unknown): Promise<void> {
    const frame = this._frame;
    if (!frame || frame.isDetached()) return;
    try {
      await frame.evaluate((d) => (globalThis as any).__port?._receive(d), data);
    } catch {
      /* navigated/detached */
    }
  }

  get onmessage(): MessageListener | null {
    return this.channel.onmessage;
  }
  set onmessage(fn: MessageListener | null) {
    this.channel.onmessage = fn;
  }
  addEventListener(type: "message", fn: MessageListener): void {
    this.channel.addEventListener(type, fn);
  }
  removeEventListener(type: "message", fn: MessageListener): void {
    this.channel.removeEventListener(type, fn);
  }
  start(): void {
    this.channel.start();
  }
  postMessage(data: unknown): void {
    this.channel.postMessage(data);
  }
  close(): void {
    this.channel.close();
  }

  async evaluate<R>(
    fnOrCode: ((...args: any[]) => R | Promise<R>) | string,
    ...args: any[]
  ): Promise<any> {
    const frame = this._frame;
    if (!frame) throw new Error(`Iframe frame not found for ${this._origin}`);
    const transformed = await transformForEvaluate(fnOrCode);
    if (typeof fnOrCode === "string") return frame.evaluate(transformed);
    const expr = `(${transformed})`;
    return frame.evaluate(
      ({ __expr__, __args__ }) => {
        const fn = (0, eval)(__expr__);
        return fn(...__args__);
      },
      { __expr__: expr, __args__: args },
    );
  }
}

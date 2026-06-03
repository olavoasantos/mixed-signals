import type { MessageListener, PlaywrightPage, PlaywrightFrame, TestHarnessEnv } from "../types.ts";
import { bundleEntry, transformForEvaluate } from "../bundle.ts";
import { PortChannel } from "./port-channel.ts";

/**
 * A TestHarnessEnv backed by a Web Worker inside a Playwright page.
 * The worker is spawned by the main frame or an iframe.
 */
export class BrowserWorkerEnv implements TestHarnessEnv {
  readonly ready: Promise<void>;
  readonly channel: PortChannel;

  private _page: PlaywrightPage;
  private _origin: string;
  private _evalId = 0;
  private _resolveReady!: () => void;

  /** Resolves once route setup is complete (before navigation). */
  readonly routesReady: Promise<void>;

  constructor(page: PlaywrightPage, entry: string, origin: string) {
    this._page = page;
    this._origin = origin;

    // Channel: outbound routes through the main frame to the worker
    this.channel = new PortChannel((data) => {
      const frame = this._page.frames()[0];
      if (!frame || frame.isDetached()) return;
      frame
        .evaluate((d) => {
          const w = (globalThis as any).__worker__;
          if (w) w.postMessage(d);
        }, data)
        .catch(() => {});
    });

    this.routesReady = this._setup(entry);
    this.ready = new Promise<void>((resolve) => {
      this._resolveReady = resolve;
    });
  }

  _markReady(): void {
    this._resolveReady();
  }

  private async _setup(entry: string): Promise<void> {
    const workerCode = await bundleEntry(entry);
    const workerUrl = `${this._origin}/worker.js`;
    await this._page.route(workerUrl, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: workerCode,
      });
    });
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
    const transformed = await transformForEvaluate(fnOrCode);
    const id = `eval-${++this._evalId}`;
    const result = this._page.evaluate(
      ({ code, evalArgs, evalId }) => {
        return new Promise<unknown>((resolve, reject) => {
          const w = (globalThis as any).__worker__;
          if (!w) {
            reject(new Error("No __worker__ found in main frame"));
            return;
          }
          const handler = (event: any) => {
            if (event.data?.__type__ === "evalResult" && event.data.__id__ === evalId) {
              w.removeEventListener("message", handler);
              if (event.data.error) reject(new Error(event.data.error));
              else resolve(event.data.result);
            }
          };
          w.addEventListener("message", handler);
          w.postMessage({ __type__: "eval", code, args: evalArgs, __id__: evalId });
        });
      },
      { code: transformed, evalArgs: args, evalId: id },
    );
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`evaluate() timed out after 10000ms (id: ${id})`)), 10_000);
    });
    return Promise.race([result, timeout]);
  }
}

/**
 * A TestHarnessEnv backed by a Web Worker nested inside an iframe.
 */
export class BrowserNestedWorkerEnv implements TestHarnessEnv {
  readonly ready: Promise<void>;
  readonly channel: PortChannel;

  private _page: PlaywrightPage;
  private _iframeOrigin: string;
  private _frameRef: PlaywrightFrame | null = null;
  private _evalId = 0;
  private _resolveReady!: () => void;

  constructor(page: PlaywrightPage, iframeOrigin: string) {
    this._page = page;
    this._iframeOrigin = iframeOrigin;

    this.channel = new PortChannel((data) => {
      const frame = this._frame;
      if (!frame || frame.isDetached()) return;
      frame
        .evaluate((d) => {
          const w = (globalThis as any).__worker__;
          if (w) w.postMessage(d);
        }, data)
        .catch(() => {});
    });

    this.ready = new Promise<void>((resolve) => {
      this._resolveReady = resolve;
    });
  }

  _markReady(): void {
    this._resolveReady();
  }

  /** Exposed so the harness can poll for worker readiness in this frame. */
  get _frame(): PlaywrightFrame | null {
    return this._frameRef;
  }

  _resolveFrame(): void {
    this._frameRef =
      this._page.frames().find((f) => f.url().startsWith(this._iframeOrigin)) ?? null;
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
    const frame = this._frameRef;
    if (!frame)
      throw new Error(`Iframe frame not found for nested worker at ${this._iframeOrigin}`);
    const transformed = await transformForEvaluate(fnOrCode);
    const id = `eval-${++this._evalId}`;
    const result = frame.evaluate(
      ({ code, evalArgs, evalId }) => {
        return new Promise<unknown>((resolve, reject) => {
          const w = (globalThis as any).__worker__;
          if (!w) {
            reject(new Error("No __worker__ found in iframe"));
            return;
          }
          const handler = (event: any) => {
            if (event.data?.__type__ === "evalResult" && event.data.__id__ === evalId) {
              w.removeEventListener("message", handler);
              if (event.data.error) reject(new Error(event.data.error));
              else resolve(event.data.result);
            }
          };
          w.addEventListener("message", handler);
          w.postMessage({ __type__: "eval", code, args: evalArgs, __id__: evalId });
        });
      },
      { code: transformed, evalArgs: args, evalId: id },
    );
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`evaluate() timed out after 10000ms (id: ${id})`)), 10_000);
    });
    return Promise.race([result, timeout]);
  }
}

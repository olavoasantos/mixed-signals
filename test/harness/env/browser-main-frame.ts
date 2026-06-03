import type { MessageListener, PlaywrightPage, PlaywrightFrame, TestHarnessEnv } from "../types.ts";
import { bundleEntry, transformForEvaluate } from "../bundle.ts";
import { PortChannel } from "./port-channel.ts";
import { htmlRoutePattern } from "./route-pattern.ts";

/**
 * A TestHarnessEnv backed by a Playwright page's main frame.
 */
export class BrowserMainFrameEnv implements TestHarnessEnv {
  readonly ready: Promise<void>;
  readonly channel: PortChannel;

  private _page: PlaywrightPage;
  private _origin: string;
  private _frame: PlaywrightFrame | null = null;

  constructor(
    page: PlaywrightPage,
    entry: string,
    origin: string,
    headers?: Record<string, string>,
    extraHtml?: string,
  ) {
    this._page = page;
    this._origin = origin;

    // Channel: outbound delivers to page's __port._receive
    this.channel = new PortChannel((data) => {
      void this._deliverToPage(data);
    });

    this.ready = this._setup(entry, headers ?? {}, extraHtml ?? "");
  }

  private async _setup(
    entry: string,
    headers: Record<string, string>,
    extraHtml: string,
  ): Promise<void> {
    const code = await bundleEntry(entry);
    const html = `<!DOCTYPE html><html><head></head><body>
      ${extraHtml}
      <script>${code}</script>
    </body></html>`;

    const htmlPattern = htmlRoutePattern(this._origin);
    const routeHeaders = { "content-type": "text/html", ...headers };
    await this._page.route(htmlPattern, (route) => {
      route.fulfill({ status: 200, body: html, headers: routeHeaders });
    });
  }

  async _navigate(): Promise<void> {
    await this._page.goto(this._origin);
    this._frame = this._page.frames()[0] ?? null;
  }

  async _deliverToPage(data: unknown): Promise<void> {
    const frame = this._frame ?? this._page.frames()[0];
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
    const frame = this._frame ?? this._page.frames()[0];
    if (!frame) throw new Error("No main frame available");
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

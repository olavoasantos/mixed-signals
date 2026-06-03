import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserTestHarnessOptions,
  IframeEnvConfig,
  PlaywrightFrame,
  PlaywrightPage,
  TestHarness,
  TestHarnessEnv,
} from "./types.ts";
import { TestProcessEnv } from "./env/test-process.ts";
import { BrowserMainFrameEnv } from "./env/browser-main-frame.ts";
import { BrowserIframeEnv } from "./env/browser-iframe.ts";
import { BrowserWorkerEnv, BrowserNestedWorkerEnv } from "./env/browser-worker.ts";
import { htmlRoutePattern } from "./env/route-pattern.ts";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const BUILTIN_WORKER_HOST_ENTRY = resolve(FIXTURES_DIR, "browser-worker-host-entry.ts");

// ─── Topology resolution ────────────────────────────────────────────────────
// Extracted from the constructor to keep it readable. Each function returns
// the fully-resolved {host, client, bridge} triple plus any side-effects
// (iframe envs, main frame env, auto-worker-host flag).

interface ResolvedTopology {
  host: TestHarnessEnv;
  client: TestHarnessEnv;
  bridge?: TestHarnessEnv;
  mainFrameEnv: BrowserMainFrameEnv | null;
  iframeEnvs: BrowserIframeEnv[];
  nestedWorkerEnv: BrowserNestedWorkerEnv | null;
  workerEnv: BrowserWorkerEnv | null;
  needsAutoWorkerHost: boolean;
}

function resolveTopology(
  page: PlaywrightPage,
  options: BrowserTestHarnessOptions,
  headers: Record<string, string>,
): ResolvedTopology {
  const mainOrigin = options.host?.origin ?? "http://host.test";
  const iframeEnvs: BrowserIframeEnv[] = [];
  let mainFrameEnv: BrowserMainFrameEnv | null = null;
  let nestedWorkerEnv: BrowserNestedWorkerEnv | null = null;
  let workerEnv: BrowserWorkerEnv | null = null;

  let host: TestHarnessEnv;
  let client: TestHarnessEnv | undefined;
  let bridge: TestHarnessEnv | undefined;

  const needsAutoWorkerHost = !options.host && !options.bridge && options.client?.type === "worker";

  // --- Collect iframe envs first (needed for main frame HTML) ---

  if (options.bridge) {
    const bridgeOrigin = options.bridge.origin ?? "http://bridge.test";
    const bridgeIframe = new BrowserIframeEnv(
      page,
      options.bridge.entry,
      bridgeOrigin,
      "bridge",
      options.bridge.client,
      headers,
    );
    iframeEnvs.push(bridgeIframe);
    bridge = bridgeIframe;

    if (options.bridge.client) {
      nestedWorkerEnv = new BrowserNestedWorkerEnv(page, bridgeOrigin);
      client = nestedWorkerEnv;
    }
  }

  if (!client && options.client?.type === "iframe") {
    const cfg = options.client as IframeEnvConfig;
    const origin = cfg.origin ?? "http://client.test";
    const iframe = new BrowserIframeEnv(page, cfg.entry, origin, "client", cfg.client, headers);
    iframeEnvs.push(iframe);

    if (cfg.client) {
      nestedWorkerEnv = new BrowserNestedWorkerEnv(page, origin);
      client = nestedWorkerEnv;
    } else {
      client = iframe;
    }
  }

  // --- Build iframe tags for main frame HTML ---

  const iframeTags = iframeEnvs
    .map((env) => `<iframe id="${env._elementId}" src="${env._iframeOrigin}/"></iframe>`)
    .join("\n");

  // --- Host ---

  if (options.host) {
    mainFrameEnv = new BrowserMainFrameEnv(
      page,
      options.host.entry,
      mainOrigin,
      headers,
      iframeTags,
    );
    host = mainFrameEnv;
  } else if (needsAutoWorkerHost) {
    mainFrameEnv = new BrowserMainFrameEnv(
      page,
      BUILTIN_WORKER_HOST_ENTRY,
      mainOrigin,
      headers,
      iframeTags,
    );
    host = new TestProcessEnv();
  } else {
    host = new TestProcessEnv();
  }

  // --- Worker client ---

  if (!client && options.client?.type === "worker") {
    workerEnv = new BrowserWorkerEnv(page, options.client.entry, mainOrigin);
    client = workerEnv;
  }

  if (!client) {
    throw new Error("BrowserTestHarness: no client configuration provided.");
  }

  return {
    host,
    client,
    bridge,
    mainFrameEnv,
    iframeEnvs,
    nestedWorkerEnv,
    workerEnv,
    needsAutoWorkerHost,
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

/**
 * Test harness for browser topologies using Playwright.
 *
 * Each environment's MessagePort-shaped channel is connected to the test
 * process: env.postMessage sends data from the env to Node, and
 * env.onmessage receives data sent from Node to the env.
 *
 * For topologies with a bridge (relay/broker), worker messages flow
 * through the bridge and are routed to BOTH the bridge and client envs,
 * so either `harness.bridge.onmessage` or `harness.client.onmessage`
 * can observe traffic.
 */
export class BrowserTestHarness implements TestHarness {
  readonly host: TestHarnessEnv;
  readonly client: TestHarnessEnv;
  readonly bridge?: TestHarnessEnv;
  readonly ready: Promise<void>;

  private _page: PlaywrightPage;
  private _mainFrameEnv: BrowserMainFrameEnv | null;
  private _iframeEnvs: BrowserIframeEnv[];
  private _nestedWorkerEnv: BrowserNestedWorkerEnv | null;
  private _workerEnv: BrowserWorkerEnv | null;
  private _headers: Record<string, string>;

  constructor(options: BrowserTestHarnessOptions) {
    this._page = options.page;

    // COI headers
    this._headers = {};
    if (options.crossOriginIsolation?.enabled) {
      this._headers["Cross-Origin-Opener-Policy"] =
        options.crossOriginIsolation.coop ?? "same-origin";
      this._headers["Cross-Origin-Embedder-Policy"] =
        options.crossOriginIsolation.coep ?? "require-corp";
    }

    const topology = resolveTopology(this._page, options, this._headers);

    this.host = topology.host;
    this.client = topology.client;
    this.bridge = topology.bridge;
    this._mainFrameEnv = topology.mainFrameEnv;
    this._iframeEnvs = topology.iframeEnvs;
    this._nestedWorkerEnv = topology.nestedWorkerEnv;
    this._workerEnv = topology.workerEnv;

    const mainOrigin = options.host?.origin ?? "http://host.test";
    this.ready = this._init(mainOrigin, topology.needsAutoWorkerHost);
  }

  private async _init(mainOrigin: string, needsAutoWorkerHost: boolean): Promise<void> {
    // Wait for route registration / bundling (but NOT worker-env readiness,
    // which requires navigation + polling and is resolved via _markReady).
    const readyPromises: Promise<void>[] = [this.host.ready];
    if (this._workerEnv) {
      readyPromises.push(this._workerEnv.routesReady);
    } else if (!this._nestedWorkerEnv || this.client !== this._nestedWorkerEnv) {
      readyPromises.push(this.client.ready);
    }
    if (this.bridge) readyPromises.push(this.bridge.ready);
    if (this._mainFrameEnv && this._mainFrameEnv !== this.host) {
      readyPromises.push(this._mainFrameEnv.ready);
    }
    await Promise.all(readyPromises);

    // --- Relay page (no explicit host) ---

    if (!this._mainFrameEnv) {
      const iframeTags = this._iframeEnvs
        .map((env) => `<iframe id="${env._elementId}" src="${env._iframeOrigin}/"></iframe>`)
        .join("\n");

      const html = `<!DOCTYPE html><html><head></head><body>\n${iframeTags}\n</body></html>`;
      const htmlPattern = htmlRoutePattern(mainOrigin);
      await this._page.route(htmlPattern, (route) => {
        route.fulfill({
          status: 200,
          body: html,
          headers: { "content-type": "text/html", ...this._headers },
        });
      });
    }

    // --- Message routing (always set up by the harness) ---

    await this._page.exposeBinding("__portToNode", (_src, data) => {
      // Route iframe messages
      for (const iframe of this._iframeEnvs) {
        const frame = this._page.frames().find((f) => f.url().startsWith(iframe._iframeOrigin));
        if (frame && _src.frame === frame) {
          iframe.channel.receive(data);
          // C2 fix: if this iframe has a nested worker, also route to it
          if (this._nestedWorkerEnv && iframe._hasNestedWorker) {
            this._nestedWorkerEnv.channel.receive(data);
          }
          // Also forward to host so host.onmessage sees client replies
          if (this.host instanceof TestProcessEnv) {
            (this.host as TestProcessEnv).channel.receive(data);
          }
          return;
        }
      }

      // Main frame messages
      const mainFrame = this._page.frames()[0];
      if (mainFrame && _src.frame === mainFrame) {
        if (this._mainFrameEnv) {
          this._mainFrameEnv.channel.receive(data);
        }
        // Also deliver to worker env (for auto-worker-host: worker replies
        // come through the main frame's __port via the relay entry)
        if (this._workerEnv) {
          this._workerEnv.channel.receive(data);
        }
        // Also deliver to TestProcessEnv host (if host is test process
        // and main frame is a relay)
        if (this.host instanceof TestProcessEnv) {
          (this.host as TestProcessEnv).channel.receive(data);
        }
      }
    });

    await this._page.addInitScript(pageSideInstall);

    // --- TestProcessEnv host outbound wiring ---
    // When the host is the test process, wire its outbound to reach the
    // client environment. The path depends on the topology:
    // - Auto-worker-host: host → main frame __port → relay → worker
    // - Iframe client: host → iframe's __port._receive
    // - Bridge + nested worker: host → bridge iframe's __port._receive
    if (this.host instanceof TestProcessEnv) {
      const testProcessHost = this.host as TestProcessEnv;

      if (needsAutoWorkerHost && this._mainFrameEnv) {
        // Auto-worker: deliver to main frame relay
        testProcessHost.channel.setDeliver((data) => {
          void this._mainFrameEnv!._deliverToPage(data);
        });
      } else if (this._iframeEnvs.length > 0) {
        // Iframe or bridge topology: deliver to the first iframe's __port
        const targetIframe = this._iframeEnvs[0];
        testProcessHost.channel.setDeliver((data) => {
          void targetIframe._deliverToFrame(data);
        });
      }
    }

    // --- Auto-worker-host URL injection ---

    if (needsAutoWorkerHost && this._mainFrameEnv) {
      const workerUrl = `${mainOrigin}/worker.js`;

      await this._page.addInitScript((url: string) => {
        (globalThis as any).__WORKER_URL__ = url;
      }, workerUrl);
    }

    // --- Navigate ---

    if (this._mainFrameEnv) {
      await this._mainFrameEnv._navigate();
    } else {
      await this._page.goto(mainOrigin);
    }

    // --- Resolve frames (with polling) ---

    for (const iframe of this._iframeEnvs) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        iframe._resolveFrame();
        if (this._page.frames().some((f) => f.url().startsWith(iframe._iframeOrigin))) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (this._nestedWorkerEnv) {
      this._nestedWorkerEnv._resolveFrame();
    }

    // Wait for workers to be created in their environments before marking ready
    if (this._workerEnv) {
      await this._waitForWorker(this._page.frames()[0]);
      this._workerEnv._markReady();
    }
    if (this._nestedWorkerEnv) {
      const nestedFrame = this._nestedWorkerEnv._frame;
      if (nestedFrame) {
        await this._waitForWorker(nestedFrame);
      }
      this._nestedWorkerEnv._markReady();
    }
  }

  private async _waitForWorker(frame: PlaywrightFrame): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const hasWorker = await frame
        .evaluate(() => typeof (globalThis as any).__worker__ !== "undefined")
        .catch(() => false);
      if (hasWorker) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      "_waitForWorker timed out after 5000ms: __worker__ never appeared in frame",
    );
  }

  async terminate(): Promise<void> {
    this.host.close();
    this.client.close();
    this.bridge?.close();

    // Terminate workers in all frames
    for (const frame of this._page.frames()) {
      if (frame.isDetached()) continue;
      try {
        await frame.evaluate(() => {
          const w = (globalThis as any).__worker__;
          if (w && typeof w.terminate === "function") w.terminate();
        });
      } catch {
        /* frame may be detached/closed */
      }
    }
  }
}

// ─── Page-side init script ──────────────────────────────────────────────────

function pageSideInstall(): void {
  let started = false;
  const queue: unknown[] = [];
  const listeners = new Set<(ev: MessageEvent) => void>();
  let onmessage: ((ev: MessageEvent) => void) | null = null;

  const dispatch = (data: unknown) => {
    const ev = new MessageEvent("message", { data });
    if (onmessage) onmessage(ev);
    listeners.forEach((l) => l(ev));
  };

  (globalThis as any).__port = {
    postMessage: (data: unknown) => (globalThis as any).__portToNode(data),
    start() {
      if (!started) {
        started = true;
        while (queue.length) dispatch(queue.shift());
      }
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(fn: ((ev: MessageEvent) => void) | null) {
      onmessage = fn;
      if (fn) (this as any).start();
    },
    addEventListener(type: string, fn: (ev: MessageEvent) => void) {
      if (type === "message") listeners.add(fn);
    },
    removeEventListener(_type: string, fn: (ev: MessageEvent) => void) {
      listeners.delete(fn);
    },
    close() {
      started = false;
      listeners.clear();
      onmessage = null;
    },
    _receive: (data: unknown) => (started ? dispatch(data) : queue.push(data)),
  };
}

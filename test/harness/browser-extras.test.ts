import { describe, expect, it, afterEach } from "vitest";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { BrowserTestHarness } from "./browser-harness.ts";
import * as topologies from "./topologies.ts";

const FIXTURES = resolve(import.meta.dirname, "__fixtures__");
const WORKER_ENTRY = resolve(FIXTURES, "browser-worker-entry.ts");
const IFRAME_ENTRY = resolve(FIXTURES, "browser-iframe-entry.ts");

let browser: Browser;
let page: Page;

async function setup(): Promise<void> {
  browser = await chromium.launch();
  page = await browser.newPage();
}

async function teardown(): Promise<void> {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
}

describe("BrowserTestHarness: same-origin worker", () => {
  let harness: BrowserTestHarness;

  afterEach(async () => {
    await harness?.terminate();
    await teardown();
  });

  it("auto-generates worker host when no hostEntry provided", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.sameOriginWorker({
        clientEntry: WORKER_ENTRY,
      }),
    });

    await harness.ready;

    expect(harness.host).toBeDefined();
    expect(harness.client).toBeDefined();
    expect(harness.bridge).toBeUndefined();
  });

  it("evaluate() runs code in the worker", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.sameOriginWorker({
        clientEntry: WORKER_ENTRY,
      }),
    });

    await harness.ready;

    const result = await harness.client.evaluate(() => "worker-says-hi");
    expect(result).toBe("worker-says-hi");
  }, 15000);

  it("MessagePort round-trips through the worker via auto-host", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.sameOriginWorker({
        clientEntry: WORKER_ENTRY,
      }),
    });

    await harness.ready;

    // The auto-host bridges: host.postMessage -> main frame -> worker
    // and worker messages -> main frame -> host.onmessage
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for worker reply")), 5000);
      harness.host.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data);
      };
    });

    harness.host.postMessage({ __type__: "echo", payload: "worker-test" });

    const data = await reply;
    expect(data).toEqual({
      __type__: "echo-reply",
      payload: "worker-test",
      source: "worker",
    });
  }, 15000);
});

describe("BrowserTestHarness: COI headers", () => {
  let harness: BrowserTestHarness;

  afterEach(async () => {
    await harness?.terminate();
    await teardown();
  });

  it("crossOriginIsolated is true on the host when COI headers are set", async () => {
    // COI requires trustworthy origins — use https
    browser = await chromium.launch();
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await ctx.newPage();

    harness = new BrowserTestHarness({
      page,
      crossOriginIsolation: { enabled: true },
      host: {
        type: "main-frame",
        entry: resolve(FIXTURES, "browser-iframe-entry.ts"),
        origin: "https://host.test",
      },
      client: {
        type: "iframe",
        entry: resolve(FIXTURES, "browser-iframe-entry.ts"),
        origin: "https://client.test",
      },
    });

    await harness.ready;

    // The top-level document (host) should be cross-origin isolated.
    // This enables SharedArrayBuffer + Atomics for sync RPC.
    const isCOI = await harness.host.evaluate(() => {
      return self.crossOriginIsolated;
    });
    expect(isCOI).toBe(true);
  }, 30000);

  it("crossOriginIsolated is false on the host without COI headers", async () => {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await ctx.newPage();

    harness = new BrowserTestHarness({
      page,
      host: {
        type: "main-frame",
        entry: resolve(FIXTURES, "browser-iframe-entry.ts"),
        origin: "https://host.test",
      },
      client: {
        type: "iframe",
        entry: resolve(FIXTURES, "browser-iframe-entry.ts"),
        origin: "https://client.test",
      },
    });

    await harness.ready;

    const isCOI = await harness.host.evaluate(() => {
      return self.crossOriginIsolated;
    });
    expect(isCOI).toBe(false);
  }, 30000);
});

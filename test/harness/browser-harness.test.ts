import { describe, expect, it, afterEach } from "vitest";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { BrowserTestHarness } from "./browser-harness.ts";
import * as topologies from "./topologies.ts";

const FIXTURES = resolve(import.meta.dirname, "__fixtures__");
const IFRAME_ENTRY = resolve(FIXTURES, "browser-iframe-entry.ts");
const WORKER_ENTRY = resolve(FIXTURES, "browser-worker-entry.ts");
const RELAY_ENTRY = resolve(FIXTURES, "browser-relay-entry.ts");

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

describe("BrowserTestHarness: iframe", () => {
  let harness: BrowserTestHarness;

  afterEach(async () => {
    await harness?.terminate();
    await teardown();
  });

  it("creates with test process host and iframe client", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.iframe({
        clientEntry: IFRAME_ENTRY,
      }),
    });

    await harness.ready;

    expect(harness.host).toBeDefined();
    expect(harness.client).toBeDefined();
    expect(harness.bridge).toBeUndefined();
  });

  it("evaluate() runs code in the iframe", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.iframe({
        clientEntry: IFRAME_ENTRY,
      }),
    });

    await harness.ready;

    const result = await harness.client.evaluate(() => {
      return 1 + 2;
    });
    expect(result).toBe(3);
  });

  it("evaluate() can access __port in the iframe", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.iframe({
        clientEntry: IFRAME_ENTRY,
      }),
    });

    await harness.ready;

    const hasPort = await harness.client.evaluate(() => {
      return typeof (globalThis as any).__port !== "undefined";
    });
    expect(hasPort).toBe(true);
  });

  it("host.postMessage reaches the iframe client", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.iframe({
        clientEntry: IFRAME_ENTRY,
      }),
    });

    await harness.ready;

    // host.postMessage should deliver to the iframe's __port
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout")), 5000);
      harness.host.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data);
      };
    });

    // The iframe entry echoes __type__:'echo' messages back through __port
    harness.host.postMessage({ __type__: "echo", payload: "from-host" });

    const data = await reply;
    expect(data).toEqual({
      __type__: "echo-reply",
      payload: "from-host",
      source: "iframe",
    });
  });

  it("MessagePort channel round-trips through the iframe", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.iframe({
        clientEntry: IFRAME_ENTRY,
      }),
    });

    await harness.ready;

    const reply = new Promise<unknown>((resolve) => {
      harness.client.onmessage = (ev) => resolve(ev.data);
    });

    harness.client.postMessage({ __type__: "echo", payload: "hello" });

    const data = await reply;
    expect(data).toEqual({
      __type__: "echo-reply",
      payload: "hello",
      source: "iframe",
    });
  });
});

describe("BrowserTestHarness: cross-origin iframe", () => {
  let harness: BrowserTestHarness;

  afterEach(async () => {
    await harness?.terminate();
    await teardown();
  });

  it("creates with separate origins", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.crossOriginIframe({
        clientEntry: IFRAME_ENTRY,
        hostOrigin: "http://host.test",
        clientOrigin: "http://client.test",
      }),
    });

    await harness.ready;

    expect(harness.host).toBeDefined();
    expect(harness.client).toBeDefined();
  });

  it("evaluate() works in cross-origin iframe", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.crossOriginIframe({
        clientEntry: IFRAME_ENTRY,
      }),
    });

    await harness.ready;

    const result = await harness.client.evaluate(() => 42);
    expect(result).toBe(42);
  });

  it("MessagePort round-trips through cross-origin iframe", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.crossOriginIframe({
        clientEntry: IFRAME_ENTRY,
      }),
    });

    await harness.ready;

    const reply = new Promise<unknown>((resolve) => {
      harness.client.onmessage = (ev) => resolve(ev.data);
    });

    harness.client.postMessage({ __type__: "echo", payload: "cross" });

    const data = await reply;
    expect(data).toEqual({
      __type__: "echo-reply",
      payload: "cross",
      source: "iframe",
    });
  });
});

describe("BrowserTestHarness: cross-origin worker relay", () => {
  let harness: BrowserTestHarness;

  afterEach(async () => {
    await harness?.terminate();
    await teardown();
  });

  it("creates with bridge iframe and nested worker", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.crossOriginWorkerRelay({
        bridgeEntry: RELAY_ENTRY,
        clientEntry: WORKER_ENTRY,
      }),
    });

    await harness.ready;

    expect(harness.host).toBeDefined();
    expect(harness.bridge).toBeDefined();
    expect(harness.client).toBeDefined();
  });

  it("evaluate() runs code in the nested worker via iframe", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.crossOriginWorkerRelay({
        bridgeEntry: RELAY_ENTRY,
        clientEntry: WORKER_ENTRY,
      }),
    });

    await harness.ready;

    // Verify the worker exists in the iframe
    const hasWorker = await harness.bridge!.evaluate(() => {
      return typeof (globalThis as any).__worker__ !== "undefined";
    });
    expect(hasWorker).toBe(true);

    const result = await harness.client.evaluate(() => "from-worker");
    expect(result).toBe("from-worker");
  }, 30000);

  it("MessagePort round-trips through bridge to worker", async () => {
    await setup();

    harness = new BrowserTestHarness({
      page,
      ...topologies.crossOriginWorkerRelay({
        bridgeEntry: RELAY_ENTRY,
        clientEntry: WORKER_ENTRY,
      }),
    });

    await harness.ready;

    // C2 fix: messages should arrive on harness.client (the nested worker),
    // not just on harness.bridge. Test both.
    const clientReply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout: client")), 10000);
      harness.client.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data);
      };
    });

    // Send through bridge to worker
    harness.bridge!.postMessage({ __type__: "echo", payload: "relay" });

    const data = await clientReply;
    expect(data).toEqual({
      __type__: "echo-reply",
      payload: "relay",
      source: "worker",
    });
  }, 30000);
});

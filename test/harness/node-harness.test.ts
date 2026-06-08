import { describe, expect, it, afterEach } from "vitest";
import { resolve } from "node:path";
import { NodeTestHarness } from "./node-harness.ts";
import { TestProcessEnv } from "./env/test-process.ts";

const WORKER_ENTRY = resolve(import.meta.dirname, "__fixtures__/node-worker-entry.ts");

describe("TestProcessEnv", () => {
  it("evaluate runs functions in-process", async () => {
    const env = new TestProcessEnv();
    const result = await env.evaluate((a: number, b: number) => a + b, 2, 3);
    expect(result).toBe(5);
  });

  it("evaluate runs code strings", async () => {
    const env = new TestProcessEnv();
    const result = await env.evaluate("return 42");
    expect(result).toBe(42);
  });

  it("ready resolves immediately", async () => {
    const env = new TestProcessEnv();
    await expect(env.ready).resolves.toBeUndefined();
  });

  it("queues messages until start()", () => {
    const env = new TestProcessEnv();
    const received: unknown[] = [];

    env.addEventListener("message", (ev) => received.push(ev.data));

    // Deliver messages before start — they should queue
    env.channel.receive("a");
    env.channel.receive("b");
    expect(received).toEqual([]);

    // Start drains the queue
    env.start();
    expect(received).toEqual(["a", "b"]);
  });

  it("setting onmessage implicitly starts", () => {
    const env = new TestProcessEnv();
    const received: unknown[] = [];

    env.channel.receive("queued");

    // Assigning onmessage should drain the queue
    env.onmessage = (ev) => received.push(ev.data);
    expect(received).toEqual(["queued"]);
  });

  it("close() neutering — messages are silently dropped", () => {
    const env = new TestProcessEnv();
    const received: unknown[] = [];
    env.onmessage = (ev) => received.push(ev.data);

    env.close();
    env.channel.receive("after-close");
    expect(received).toEqual([]);
  });

  it("postMessage calls deliver", () => {
    const env = new TestProcessEnv();
    const sent: unknown[] = [];
    env.channel.setDeliver((data) => sent.push(data));

    env.postMessage("hello");
    expect(sent).toEqual(["hello"]);
  });
});

describe("NodeTestHarness", () => {
  let harness: NodeTestHarness;

  afterEach(async () => {
    if (harness) await harness.terminate();
  });

  it("creates with test process as host by default", async () => {
    harness = new NodeTestHarness({
      client: { entry: WORKER_ENTRY },
    });

    await harness.ready;

    // Host should be immediately ready (test process)
    expect(harness.host).toBeDefined();
    expect(harness.client).toBeDefined();
    expect(harness.bridge).toBeUndefined();
  });

  it("evaluate() runs code in the worker", async () => {
    harness = new NodeTestHarness({
      client: { entry: WORKER_ENTRY },
    });

    await harness.ready;

    const result = await harness.client.evaluate((a: number, b: number) => a + b, 2, 3);
    expect(result).toBe(5);
  });

  it("evaluate() handles async functions in the worker", async () => {
    harness = new NodeTestHarness({
      client: { entry: WORKER_ENTRY },
    });

    await harness.ready;

    const result = await harness.client.evaluate(() => Promise.resolve("async-result"));
    expect(result).toBe("async-result");
  });

  it("evaluate() propagates errors from the worker", async () => {
    harness = new NodeTestHarness({
      client: { entry: WORKER_ENTRY },
    });

    await harness.ready;

    await expect(
      harness.client.evaluate(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("MessagePort channel round-trips data through the worker", async () => {
    harness = new NodeTestHarness({
      client: { entry: WORKER_ENTRY },
    });

    await harness.ready;

    const reply = new Promise<unknown>((resolve) => {
      harness.client.onmessage = (ev) => resolve(ev.data);
    });

    harness.client.postMessage({ __type__: "echo", payload: "ping" });

    const data = await reply;
    expect(data).toEqual({ __type__: "echo-reply", payload: "ping" });
  });

  it("host.postMessage reaches the worker (C1 fix)", async () => {
    harness = new NodeTestHarness({
      client: { entry: WORKER_ENTRY },
    });

    await harness.ready;

    // C1 fix: host.postMessage should send to the worker's data port
    // The echo fixture replies to __type__: 'echo' messages
    const reply = new Promise<unknown>((resolve) => {
      harness.host.onmessage = (ev) => resolve(ev.data);
    });

    harness.host.postMessage({ __type__: "echo", payload: "from-host" });

    const data = await reply;
    expect(data).toEqual({ __type__: "echo-reply", payload: "from-host" });
  });

  it("terminate() shuts down cleanly", async () => {
    harness = new NodeTestHarness({
      client: { entry: WORKER_ENTRY },
    });

    await harness.ready;
    await harness.terminate();

    // After terminate, posting should be a no-op (closed)
    // This should not throw
    harness.client.postMessage("after-terminate");
  });
});

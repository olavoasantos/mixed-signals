/**
 * Auto-generated main-frame entry for the same-origin worker topology.
 *
 * Creates a Worker from __WORKER_URL__, stores it as __worker__, and
 * bridges messages between __port (Node channel) and the worker.
 */
const port = (globalThis as any).__port;
if (!port) throw new Error("No __port found — harness did not install it");

const workerUrl = (globalThis as any).__WORKER_URL__ as string;
if (!workerUrl) throw new Error("No __WORKER_URL__ found — harness did not inject it");

const worker = new Worker(workerUrl);
(globalThis as any).__worker__ = worker;

// Forward: port (Node) → worker
port.onmessage = (ev: MessageEvent) => {
  worker.postMessage(ev.data);
};

// Forward: worker → port (Node)
worker.addEventListener("message", (ev: MessageEvent) => {
  // Don't forward eval side-channel messages to Node
  if (ev.data?.__type__ === "evalResult") return;
  port.postMessage(ev.data);
});

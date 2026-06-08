/**
 * Browser entry script for an iframe environment.
 *
 * Uses the harness-provided __port to communicate with the Node test process.
 * Echoes messages back with a prefix for verification.
 */
const port = (globalThis as any).__port;
if (!port) throw new Error("No __port found — harness did not install it");

port.onmessage = (ev: MessageEvent) => {
  const data = ev.data;
  if (data && typeof data === "object" && (data as any).__type__ === "echo") {
    port.postMessage({
      __type__: "echo-reply",
      payload: (data as any).payload,
      source: "iframe",
    });
  }
};

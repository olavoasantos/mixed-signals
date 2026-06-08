/**
 * Test worker entry script for NodeWorkerEnv.
 *
 * Implements the harness protocol:
 * - Eval side-channel on parentPort ({ __type__: 'eval' } / { __type__: 'evalResult' })
 * - Data channel on workerData.port (MessagePort for RPC traffic)
 * - Ready signal: { __type__: 'ready' } posted on parentPort when setup completes
 */
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("No parentPort — not running as a worker");

const dataPort = workerData?.port as import("node:worker_threads").MessagePort;
if (!dataPort) throw new Error("No data port in workerData");

// Wire the data port — echo messages back (for testing)
dataPort.on("message", (data: unknown) => {
  // Default behavior: echo with a prefix so tests can verify round-trip
  if (data && typeof data === "object" && (data as any).__type__ === "echo") {
    dataPort.postMessage({
      __type__: "echo-reply",
      payload: (data as any).payload,
    });
  }
});

// Eval side-channel
parentPort.on("message", (data: unknown) => {
  if (data && typeof data === "object" && (data as any).__type__ === "eval") {
    const { code, args, __id__ } = data as any;
    try {
      const fn = new Function("args", `return (${code})(...args)`);
      const result = fn(args || []);
      // Handle async results
      if (result && typeof result === "object" && typeof result.then === "function") {
        result.then(
          (r: unknown) => parentPort!.postMessage({ __type__: "evalResult", __id__, result: r }),
          (e: Error) =>
            parentPort!.postMessage({ __type__: "evalResult", __id__, error: e.message }),
        );
      } else {
        parentPort.postMessage({ __type__: "evalResult", __id__, result });
      }
    } catch (e: any) {
      parentPort.postMessage({ __type__: "evalResult", __id__, error: e.message });
    }
  }
});

// Signal ready
parentPort.postMessage({ __type__: "ready" });

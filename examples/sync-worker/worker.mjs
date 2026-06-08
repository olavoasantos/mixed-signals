/**
 * sync-worker example — worker thread
 *
 * Connects to the host RPC server with a sync-capable transport,
 * then demonstrates:
 *   1. Single sync call           — rpc.wait([rpc.root.getCount()])
 *   2. N-arity batch              — rpc.wait([p1, p2, p3])
 *   3. Signal reactivity via sync — read getCount() after host-side mutation
 */

import { parentPort } from "node:worker_threads";
import { RPCClient } from "mixed-signals/client";
import { enableSyncClient, supportsSync } from "mixed-signals/sync";

if (!parentPort) throw new Error("Not running as a worker thread");

// ── Pre-flight ───────────────────────────────────────────────────────

console.log("[worker] supportsSync():", supportsSync());

// ── Transport ────────────────────────────────────────────────────────

const rawTransport = {
  mode: "raw",
  send(msg, ctx) {
    parentPort.postMessage(
      msg,
      ctx?.transfer ? { transfer: ctx.transfer } : undefined,
    );
  },
  onMessage(cb) {
    parentPort.on("message", cb);
  },
};

const syncTransport = await enableSyncClient(rawTransport);
const rpc = new RPCClient(syncTransport);
await rpc.ready;

console.log("[worker] RPCClient ready, canWait():", rpc.canWait());

// ── 1. Single sync call ─────────────────────────────────────────────

const [count] = rpc.wait([rpc.root.getCount()]);
console.log("[worker] 1 — initial count (sync):", count);

// ── 2. N-arity batch ────────────────────────────────────────────────
// All three calls are dispatched in a single SAB round-trip.

const [incremented, sum, name] = rpc.wait([
  rpc.root.increment(),
  rpc.root.add(17, 25),
  rpc.root.getName(),
]);
console.log("[worker] 2 — batch results:");
console.log("           increment() →", incremented);
console.log("           add(17,25)  →", sum);
console.log("           getName()   →", name);

// ── 3. Signal reactivity ────────────────────────────────────────────
// Wait for the host to mutate count (the host does this after ~200 ms).

await new Promise((r) => setTimeout(r, 400));

const [updatedCount] = rpc.wait([rpc.root.getCount()]);
console.log("[worker] 3 — count after host mutation (sync):", updatedCount);

// ── Done ─────────────────────────────────────────────────────────────

console.log("[worker] demo complete ✓");
process.exit(0);

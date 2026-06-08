/**
 * sync-worker example — host (main thread)
 *
 * Creates an RPC server exposing a Counter model with:
 *   - getCount()   — reads the signal value
 *   - increment()  — bumps count, returns new value
 *   - add(a, b)    — pure computation
 *   - getName()    — returns a string
 *
 * Spawns a Node worker_threads Worker, wires it up via
 * enableSyncServer, and lets the worker drive the demo.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { signal } from "@preact/signals-core";
import { RPC, createModel } from "mixed-signals/server";
import {
  enableSyncServer,
  createNodeWorkerBridge,
} from "mixed-signals/sync";

// ── Model ────────────────────────────────────────────────────────────

const Counter = createModel("Counter", () => {
  const count = signal(0);

  return {
    count,
    getCount() {
      return count.value;
    },
    increment() {
      count.value += 1;
      return count.value;
    },
    add(a, b) {
      return a + b;
    },
    getName() {
      return "SyncWorkerCounter";
    },
  };
});

const root = new Counter();

// ── Worker ───────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const worker = new Worker(resolve(__dirname, "worker.mjs"));

// ── Transport ────────────────────────────────────────────────────────

const CLIENT_ID = "worker-1";

/** Raw transport: host → worker via worker.postMessage. */
const rawTransport = {
  mode: "raw",
  send(msg, ctx) {
    worker.postMessage(
      msg,
      ctx?.transfer ? { transfer: ctx.transfer } : undefined,
    );
  },
  onMessage(cb) {
    worker.on("message", cb);
  },
};

const syncTransport = enableSyncServer(rawTransport, {
  clientId: CLIENT_ID,
  onClientDead(id) {
    console.log(`[host] client ${id} released`);
    rpc.removeClient(id);
  },
});

// ── RPC server ───────────────────────────────────────────────────────

const rpc = new RPC(root);
const disposeClient = rpc.addClient(syncTransport, CLIENT_ID);

// ── Death detection ──────────────────────────────────────────────────

const bridge = createNodeWorkerBridge({
  worker,
  onDeath() {
    console.log("[host] worker exited — cleaning up");
    syncTransport.markDead(CLIENT_ID);
    disposeClient();
    bridge.dispose();
  },
});

// ── Host-side mutation (demonstrates reactivity) ─────────────────────

// After a short delay, increment from the host so the worker can
// observe the signal value change on its next sync read.
setTimeout(() => {
  console.log("[host] incrementing count from host side → 1");
  root.increment();
}, 200);

// ── Graceful shutdown ────────────────────────────────────────────────

worker.on("exit", (code) => {
  console.log(`[host] worker exited (code ${code})`);
  bridge.dispose();
  process.exit(0);
});

/**
 * Extension worker — runs inside the iframe's origin (localhost:3001).
 *
 * Sets up a sync-capable RPC client via enableSyncClient, then
 * exercises the remote Counter model with both sync and async calls.
 *
 * The worker communicates with the iframe's broker bridge via
 * postMessage. The broker owns the SharedArrayBuffer channel that
 * powers rpc.wait() — from the worker's perspective, the setup is
 * identical to any other sync RPC client.
 */

// Dynamic imports — resolved via the import map served by server.mjs.
// Workers with type: 'module' don't support import maps in all browsers
// yet, so we use absolute URLs to the served build files.
const { RPCClient } = await import('/build/client.js');
const { enableSyncClient } = await import('/build/sync.js');

/** Post a log message to the iframe for display. */
function log(msg) {
  self.postMessage({ __workerLog: `[worker] ${msg}` });
}

log('starting…');

// ── Raw transport (worker ↔ broker) ───────────────────────────────
//
// Standard raw transport over the worker's postMessage channel.
// The broker bridge's enableSyncServer wraps this on its side.

const rawTransport = {
  mode: 'raw',
  send(data, ctx) {
    const transfer = ctx?.transfer ?? [];
    self.postMessage(data, transfer);
  },
  onMessage(cb) {
    self.addEventListener('message', (e) => {
      // Ignore our own log messages reflected back
      if (e.data?.__workerLog) return;
      cb(e.data);
    });
  },
};

// ── Enable sync client ────────────────────────────────────────────
//
// This performs the SAB handshake with the broker's enableSyncServer.
// The returned transport has a `wait` method that powers rpc.wait().

log('performing sync handshake…');
const syncTransport = await enableSyncClient(rawTransport);
log('sync handshake complete');

// ── RPC client ────────────────────────────────────────────────────

const rpc = new RPCClient(syncTransport);
await rpc.ready;
log(`RPC ready — root received`);

// ── Exercise the API ──────────────────────────────────────────────

// 1. Sync: single call
log('─── sync calls ───');
const [greeting] = rpc.wait([rpc.root.greet('Worker')]);
log(`greet() → "${greeting}"`);

// 2. Sync: batched calls (all three execute in one round-trip)
const [v1, v2, v3] = rpc.wait([
  rpc.root.increment(),
  rpc.root.increment(),
  rpc.root.increment(),
]);
log(`3× increment() → [${v1}, ${v2}, ${v3}]`);

// 3. Sync: read a snapshot
const [snap] = rpc.wait([rpc.root.getSnapshot()]);
log(`getSnapshot() → ${JSON.stringify(snap)}`);

// 4. Sync: decrement + reset
const [d1] = rpc.wait([rpc.root.decrement()]);
log(`decrement() → ${d1}`);

const [r1] = rpc.wait([rpc.root.reset()]);
log(`reset() → ${r1}`);

// 5. Async call (works exactly like normal — await instead of wait)
log('─── async call ───');
const asyncResult = await rpc.root.greet('AsyncWorker');
log(`async greet() → "${asyncResult}"`);

// 6. Final snapshot
const [finalSnap] = rpc.wait([rpc.root.getSnapshot()]);
log(`final getSnapshot() → ${JSON.stringify(finalSnap)}`);

log('✅ all calls complete');

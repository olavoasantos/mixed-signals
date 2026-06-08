# sync-worker example

Demonstrates the **worker ↔ main** synchronous RPC topology using
Node `worker_threads` and `mixed-signals/sync`.

## What it shows

| Concept | Where |
|---|---|
| Server setup with `RPC` + `createModel` | `main.mjs` |
| `enableSyncServer` raw transport wrapping | `main.mjs` |
| `createNodeWorkerBridge` death detection | `main.mjs` |
| `enableSyncClient` + `RPCClient` in a worker | `worker.mjs` |
| `supportsSync()` and `rpc.canWait()` pre-flight | `worker.mjs` |
| Single sync call — `rpc.wait([rpc.root.getCount()])` | `worker.mjs` |
| N-arity batch — `rpc.wait([p1, p2, p3])` | `worker.mjs` |
| Signal reactivity — reading a value after host mutation | `worker.mjs` |

## How to run

```bash
# from the repo root
pnpm install
pnpm build          # builds the library — examples import from build/
cd examples/sync-worker
pnpm dev
```

Or from the repo root:

```bash
pnpm build
node examples/sync-worker/main.mjs
```

## Expected output

```
[worker] supportsSync(): true
[worker] RPCClient ready, canWait(): true
[worker] 1 — initial count (sync): 0
[worker] 2 — batch results:
           increment() → 1
           add(17,25)  → 42
           getName()   → SyncWorkerCounter
[host] incrementing count from host side → 1
[worker] 3 — count after host mutation (sync): 2
[worker] demo complete ✓
[host] worker exited — cleaning up
[host] client worker-1 released
[host] worker exited (code 0)
```

The death-detection callbacks fire on normal exits too — that's
expected. In production you'd gate cleanup on whether the exit
was intentional.

## Files

- **`main.mjs`** — Host/server. Creates the `Counter` model, spawns
  the worker, wires `enableSyncServer`, and handles death detection
  via `createNodeWorkerBridge`.
- **`worker.mjs`** — Worker/client. Handshakes with `enableSyncClient`,
  then uses `rpc.wait(...)` to make synchronous RPC calls.

## Further reading

- [Sync mode design doc](../../docs/sync-mode.md)
- [Architecture overview](../../ARCHITECTURE.md)

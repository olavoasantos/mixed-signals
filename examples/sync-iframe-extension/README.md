# Cross-Origin Iframe Broker — Sync RPC Example

This example demonstrates the **cross-origin iframe broker** topology for
`mixed-signals` sync RPC — the canonical pattern for Shopify extensions
where a host page and an extension iframe live on different origins.

## What it shows

```
┌─────────────────────────────────────────────────────────────┐
│  Parent (host)  — localhost:3000                            │
│  ┌────────────────────────────────────┐                     │
│  │  RPC server  (Counter model)       │                     │
│  │  Signals: count, label             │                     │
│  │  Methods: increment, greet, …      │                     │
│  └──────────┬─────────────────────────┘                     │
│             │ MessagePort (async)                           │
│  ┌──────────┴─────────────────────────────────────────────┐ │
│  │  Iframe (broker)  — localhost:3001                     │ │
│  │  ┌───────────────────────────────┐                     │ │
│  │  │  createIframeBrokerBridge()   │                     │ │
│  │  │  Owns the SAB pair            │                     │ │
│  │  └──────────┬────────────────────┘                     │ │
│  │             │ SharedArrayBuffer (sync)                  │ │
│  │  ┌──────────┴────────────────────┐                     │ │
│  │  │  Worker  (extension code)     │                     │ │
│  │  │  rpc.wait([…]) — blocks here  │                     │ │
│  │  └───────────────────────────────┘                     │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** The `SharedArrayBuffer` never crosses the cross-origin
boundary. The iframe broker allocates the SAB pair inside its own agent
cluster and transfers them to the same-origin worker. The parent ↔ iframe
hop uses a plain `MessagePort` (async). The broker bridges the impedance
mismatch.

## How to run

```bash
# From the repo root — build the library first
pnpm build

# Install example dependencies
cd examples/sync-iframe-extension
pnpm install

# Start the dual-origin dev server
pnpm dev
```

Then open **http://localhost:3000** in your browser.

You'll see:
- The **parent page** at `localhost:3000` with the RPC server log
- An **embedded iframe** at `localhost:3001` with the broker + worker logs
- The worker making sync and async RPC calls to the parent's Counter model

## Files

| File | Role |
|---|---|
| `server.mjs` | Node HTTP server — serves both origins (`:3000` and `:3001`) with COOP/COEP headers |
| `parent.html` | Host page — creates the RPC server, Counter model, and tunnels a `MessagePort` to the iframe |
| `iframe.html` | Broker page — receives the port, spawns the worker, creates `IframeBrokerBridge` |
| `worker.mjs` | Extension worker — `enableSyncClient` + `RPCClient` + sync/async calls |

## Cross-Origin Isolation (COOP/COEP)

`SharedArrayBuffer` requires [Cross-Origin Isolation][coi]. **Both**
origins must serve these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Additionally, cross-origin resources (the iframe, build files served to
the other origin) need:

```
Cross-Origin-Resource-Policy: cross-origin
```

The `server.mjs` in this example sets all three headers on every response.

**Verify in DevTools:** Open the console and check
`crossOriginIsolated === true`. If it's `false`, the parent status bar
will show a red warning and the broker bridge will throw
`SyncRPCIframeBridgeError`.

[coi]: https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated

## The tunneled MessagePort pattern

This example uses the **tunneled `MessagePort`** variant (as opposed to
direct `window.postMessage`). The parent creates a `MessageChannel`,
transfers `port2` to the iframe, and uses `port1` as its raw transport:

```
Parent                          Iframe
  │                               │
  ├─ new MessageChannel()         │
  ├─ postMessage({port: port2}) ──┤ receives port2
  │                               ├─ wrapMessagePort({port})
  ├─ rpc.addClient(port1)        ├─ createIframeBrokerBridge({hostTransport, worker})
  │                               │
  ├──── async RPC (port1 ↔ port2) ────┤
  │                               ├──── sync RPC (SAB ↔ worker) ────┤
```

This is more robust than direct `window.postMessage` because:
- The `MessagePort` is a dedicated channel — no filtering by `event.source`
- No origin-checking required on individual messages (origin was validated
  at port transfer time)
- Multiple independent channels can coexist (one per iframe/extension)

## Common gotchas

1. **`crossOriginIsolated` is false** — Check that BOTH origins serve
   COOP + COEP. A single missing header breaks the entire chain. Chrome
   DevTools → Application → Frames shows the isolation status per frame.

2. **Worker import errors** — Module workers (`type: 'module'`) don't
   support import maps in all browsers. This example uses absolute URLs
   (`/build/client.js`) in the worker instead.

3. **Port not received** — The iframe must be loaded before the parent
   sends the port. This example waits for the iframe's `load` event.

4. **SAB rejected in postMessage** — If you see `messageerror` events,
   you're likely trying to send a `SharedArrayBuffer` across a
   cross-origin boundary. That's exactly what the broker pattern avoids —
   the SAB stays within the iframe's agent cluster.

## Further reading

- [`docs/sync-mode.md`](../../docs/sync-mode.md) — Full sync RPC documentation
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Library architecture overview

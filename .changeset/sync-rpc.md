---
'mixed-signals': minor
---

New entry point `mixed-signals/sync` for synchronous RPC from
worker-side callers.

The headline primitive is `rpc.wait(promises)`, which blocks on one or
more in-flight RPC promises in a single `SharedArrayBuffer` round-trip.
Callers pass an arbitrary number of promises (N-arity); all are settled
before the blocking thread resumes.

**Hard requirement:** every context in the chain must be served with
cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`). Without these headers
`SharedArrayBuffer` is unavailable and the import will throw at setup
time.

`rpc.wait()` is restricted to Worker callers. Invoking it on the main
thread or inside a ServiceWorker throws immediately — blocking either
context would deadlock the page or violate the ServiceWorker lifecycle.

Three topologies are supported out of the box:

- **Worker ↔ Main** — direct `postMessage` channel.
- **Same-origin iframe relay** — parent hosts the RPC server, a
  same-origin iframe relays SABs + postMessages to the worker.
- **Cross-origin iframe broker** — parent hosts the RPC server,
  a cross-origin iframe acts as an active broker bridging async
  (parent ↔ iframe) and sync (iframe ↔ worker) channels.

See `docs/sync-mode.md` for the full integration guide and `examples/`
for runnable demos covering each topology.

This is a **minor** version bump: new entry point only, no breaking
changes to existing `mixed-signals` exports.

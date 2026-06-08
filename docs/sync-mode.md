# Sync RPC (`mixed-signals/sync`)

Block on one or more in-flight RPC promises from a worker thread and get
hydrated results back **synchronously** — via `SharedArrayBuffer` +
`Atomics.wait`, in a single round-trip.

```ts
import { RPCClient } from 'mixed-signals/client';
import { enableSyncClient } from 'mixed-signals/sync';

const syncTransport = await enableSyncClient(rawTransport);
const rpc = new RPCClient(syncTransport);

// Synchronous! Blocks until the host responds.
const [user] = rpc.wait([rpc.root.getUser(42)]);
console.log(user.name); // available immediately
```

---

## Table of contents

- [Overview — when to use](#overview-when-to-use)
- [Setup recipes](#setup-recipes)
- [The drain-barrier contract](#the-drain-barrier-contract)
- [Errors](#errors)
- [Cross-origin isolation](#cross-origin-isolation)
- [Debugging tips](#debugging-tips)
- [Performance characteristics](#performance-characteristics)
- [Limitations](#limitations)
- [The SyncablePromise auto-fire semantic](#the-syncablepromise-auto-fire-semantic)

---

## Overview — when to use

Async RPC is the default. Every method call on a hydrated proxy returns a
`Promise` that resolves when the host responds — under clean conditions
that round-trip takes **~110–220 µs**.

The problem appears under **contention**: if the host's main thread is busy
(layout, paint, long-running JS), the event-loop latency balloons to
**2–10 ms per call**. That's the *contested-baseline* scenario — and it's
the normal operating environment for real applications.

Sync RPC eliminates the event-loop wait. The worker calls `rpc.wait(...)`,
which blocks via `Atomics.wait` while the host services the request on the
next microtask. Measured improvement: **200–1000× contested speedup**,
because the host processes the batch immediately instead of queuing behind
`requestAnimationFrame` and other macrotasks.

**Use sync RPC when:**

- The caller is a worker and blocking is acceptable.
- You need multiple calls to appear atomic — `rpc.wait([a, b, c])` batches
  all three in one round-trip.
- Contention on the host thread makes async latency unpredictable.

**Stick with async when:**

- The caller is the main thread (browsers forbid `Atomics.wait` there).
- You don't control the COOP/COEP headers required for `SharedArrayBuffer`
  (see [Cross-origin isolation](#cross-origin-isolation)).

---

## Setup recipes

Every topology follows the same pattern:

1. **Host side** — wrap the raw transport with `enableSyncServer`.
2. **Client side** (worker) — wrap the raw transport with `enableSyncClient`.
3. **Call** — use `rpc.wait([...])` for sync, or `await` for async.

### Worker ↔ main (Node worker_threads)

**host.ts** (main thread):

```ts
import { Worker } from 'node:worker_threads';
import { RPC } from 'mixed-signals/server';
import { enableSyncServer } from 'mixed-signals/sync';

const worker = new Worker('./worker.js');
const rawTransport = {
  mode: 'raw' as const,
  send: (data: unknown) => worker.postMessage(data),
  onMessage: (cb: (data: unknown) => void) => worker.on('message', cb),
};

const syncTransport = enableSyncServer(rawTransport);
const rpc = new RPC(root);        // `root` is your API object
rpc.addClient(syncTransport);
```

**worker.ts** (worker thread):

```ts
import { parentPort } from 'node:worker_threads';
import { RPCClient } from 'mixed-signals/client';
import { enableSyncClient, supportsSync } from 'mixed-signals/sync';

const rawTransport = {
  mode: 'raw' as const,
  send: (data: unknown) => parentPort!.postMessage(data),
  onMessage: (cb: (data: unknown) => void) => parentPort!.on('message', cb),
};

const syncTransport = await enableSyncClient(rawTransport);
const rpc = new RPCClient(syncTransport);

if (rpc.canWait()) {
  const [result] = rpc.wait([rpc.root.someMethod()]);
}
```

### Worker ↔ main (browser DedicatedWorker)

**host.ts** (main thread):

```ts
import { RPC } from 'mixed-signals/server';
import { enableSyncServer } from 'mixed-signals/sync';

const worker = new Worker('/worker.js');
const rawTransport = {
  mode: 'raw' as const,
  send: (data: unknown) => worker.postMessage(data),
  onMessage: (cb: (data: unknown) => void) =>
    worker.addEventListener('message', (e) => cb(e.data)),
};

const syncTransport = enableSyncServer(rawTransport);
const rpc = new RPC(root);
rpc.addClient(syncTransport);
```

**worker.ts** — identical to the Node worker recipe above, substituting
`self.postMessage` / `self.addEventListener('message', ...)` for the
Node `parentPort` equivalents:

```ts
import { RPCClient } from 'mixed-signals/client';
import { enableSyncClient } from 'mixed-signals/sync';

const rawTransport = {
  mode: 'raw' as const,
  send: (data: unknown) => self.postMessage(data),
  onMessage: (cb: (data: unknown) => void) =>
    self.addEventListener('message', (e) => cb(e.data)),
};

const syncTransport = await enableSyncClient(rawTransport);
const rpc = new RPCClient(syncTransport);
const [value] = rpc.wait([rpc.root.getValue()]);
```

> **Prerequisite:** The page must be
> [cross-origin isolated](#cross-origin-isolation) for `SharedArrayBuffer`.

### Same-origin iframe relay

Use `createIframeRelayBridge` when the parent page and iframe share an
origin. The iframe is a transparent forwarder — SABs travel parent → iframe
→ worker via `postMessage` without copying.

**Parent page** (host):

```ts
import { RPC } from 'mixed-signals/server';
import { enableSyncServer } from 'mixed-signals/sync';

const iframe = document.getElementById('ext') as HTMLIFrameElement;
const rawTransport = {
  mode: 'raw' as const,
  send: (data: unknown) =>
    iframe.contentWindow!.postMessage(data, location.origin),
  onMessage: (cb: (data: unknown) => void) =>
    window.addEventListener('message', (e) => {
      if (e.source === iframe.contentWindow) cb(e.data);
    }),
};

const syncTransport = enableSyncServer(rawTransport);
const rpc = new RPC(root);
rpc.addClient(syncTransport);
```

**Iframe page** (relay):

```ts
import { createIframeRelayBridge } from 'mixed-signals/sync';

const worker = new Worker('/ext-worker.js');
const bridge = createIframeRelayBridge({
  worker,
  parentOrigin: location.origin,
});
window.addEventListener('unload', () => bridge.dispose());
```

**Extension worker** — same as the
[browser DedicatedWorker recipe](#worker-main-browser-dedicatedworker).
The worker is unaware of the relay.

### Cross-origin iframe broker (direct adapter)

Use `createIframeBrokerBridge` when parent and iframe are on different
origins. The broker **owns** the SAB pair inside the iframe's agent
cluster — the SAB never crosses the cross-origin boundary. The
parent ↔ iframe leg is plain async `postMessage`.

**Parent page** (host — different origin):

```ts
import { RPC } from 'mixed-signals/server';

const iframe = document.getElementById('ext') as HTMLIFrameElement;
const rawTransport = {
  mode: 'raw' as const,
  send: (data: unknown) =>
    iframe.contentWindow!.postMessage(data, 'https://cdn.example.com'),
  onMessage: (cb: (data: unknown) => void) =>
    window.addEventListener('message', (e) => {
      if (e.origin === 'https://cdn.example.com') cb(e.data);
    }),
};

const rpc = new RPC(root);
rpc.addClient(rawTransport);    // async-only on the parent side
```

**Iframe page** (broker — `https://cdn.example.com`):

```ts
import {
  createIframeBrokerBridge,
  wrapWindowPostMessage,
} from 'mixed-signals/sync';

const worker = new Worker('/ext-worker.js');
const hostTransport = wrapWindowPostMessage({
  source: window.parent,
  targetOrigin: 'https://shop.example.com',
});

const bridge = createIframeBrokerBridge({
  worker,
  hostTransport,
  dataSabSize: 64 * 1024,         // optional; default 64 KiB
});
window.addEventListener('unload', () => bridge.dispose());
```

**Extension worker** — same as the
[browser DedicatedWorker recipe](#worker-main-browser-dedicatedworker).

### Cross-origin broker with tunneled MessagePort

The canonical shape for Shopify extensions: the parent tunnels a
`MessagePort` to the iframe, and the broker wraps it with `wrapMessagePort`.

**Parent page** (host):

```ts
import { RPC } from 'mixed-signals/server';

const iframe = document.getElementById('ext') as HTMLIFrameElement;
const channel = new MessageChannel();

iframe.contentWindow!.postMessage(
  { type: 'init', port: channel.port2 },
  'https://cdn.example.com',
  [channel.port2],
);

const rawTransport = {
  mode: 'raw' as const,
  send: (data: unknown) => channel.port1.postMessage(data),
  onMessage: (cb: (data: unknown) => void) => {
    channel.port1.addEventListener('message', (e) => cb(e.data));
    channel.port1.start();
  },
};

const rpc = new RPC(root);
rpc.addClient(rawTransport);
```

**Iframe page** (broker — `https://cdn.example.com`):

```ts
import { createIframeBrokerBridge, wrapMessagePort } from 'mixed-signals/sync';

const worker = new Worker('/ext-worker.js');

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'init') return;
  const hostTransport = wrapMessagePort({ port: e.data.port });
  const bridge = createIframeBrokerBridge({ worker, hostTransport });
  window.addEventListener('unload', () => bridge.dispose());
});
```

**Extension worker** — same as the
[browser DedicatedWorker recipe](#worker-main-browser-dedicatedworker).

---

## The drain-barrier contract

When `rpc.wait(promises)` returns, the worker is guaranteed to see
**fresh state** — every signal mutation the host emitted while servicing
the batch is applied before the caller's next line runs.

### Captured during call

Signal mutations emitted **as a direct consequence** of the batched calls
(e.g., the host method writes to a signal and the `@S` frame fires) are
captured into the response timeline and replayed into the worker's reactive
layer before `rpc.wait` returns.

### Microtask-exhaustion replay

Additional signal frames emitted during microtask exhaustion (computed
signals deriving from written signals) are collected into the **replay
log**. On the next `rpc.wait`, the host prepends unreplayed frames to the
response timeline — the worker applies them before returning.

### Between-call frames

Between sync calls, the host sends signal frames via the normal async
`postMessage` channel as `{__sync: 'frame', seq, msg}` envelopes. The
worker tracks the highest applied sequence (`CLIENT_APPLIED_SEQ`); on the
next `rpc.wait`, the host only replays frames past that watermark.

**The invariant:** after `rpc.wait` returns, the worker's signal graph is
consistent with the host's signal graph as of the end of batch dispatch.
There is no window where stale signal values are visible.

---

## Errors

All sync RPC errors extend `SyncRPCError`. A single `instanceof` check
covers the entire family:

```ts
import { SyncRPCError } from 'mixed-signals/sync';

try {
  rpc.wait([rpc.root.doSomething()]);
} catch (e) {
  if (e instanceof SyncRPCError) {
    console.error(e.name, e.message);
  }
}
```

Every error `.name` is a string literal that survives minification and
works across realms: `e.name === 'SyncRPCTimeoutError'`.

### `SyncRPCError` (base)

Thrown directly for protocol-level issues: malformed response buffers,
negative record counts, trailing bytes after decoding, unknown wire types,
or sidecar transfer failures.

**Response:** Check that both sides run the same version of
`mixed-signals/sync`. If the error mentions a sidecar transfer failure,
verify the transferable hasn't been detached.

#### `SyncRPCNotCrossOriginIsolatedError`

**Trigger:** `crossOriginIsolated === false` — `SharedArrayBuffer` is
unavailable.

**Response:** Configure COOP + COEP on every document in the chain. See
[Cross-origin isolation](#cross-origin-isolation) for required headers.

### Worker context

#### `SyncRPCUnsupportedContextError`

**Trigger:** `rpc.wait(...)` called from a context that cannot block —
browser main threads, `ServiceWorker`, or environments missing
`SharedArrayBuffer`.

**Response:** Move sync-calling code into a worker. Use `supportsSync()`
to feature-detect:

```ts
import { supportsSync } from 'mixed-signals/sync';

if (supportsSync()) {
  const [val] = rpc.wait([rpc.root.get()]);
} else {
  const val = await rpc.root.get();
}
```

### Timeout

#### `SyncRPCTimeoutError`

**Trigger:** Host didn't respond in time. Two situations:

1. **Handshake timeout** — `enableSyncClient` didn't receive `hs-res`
   within `opts.timeoutMs` (default 5 000 ms).
2. **Call timeout** — `Atomics.wait` exceeded the deadline during
   `rpc.wait(...)` (only when `timeoutMs` was passed).

**Response:**
- Handshake: verify `enableSyncServer` was called and the transport is
  connected. Check for `messageerror` events.
- Call: the host's main thread may be blocked. Profile for long tasks.
  Increase `timeoutMs` or batch more calls.

> **Note:** `rpc.wait` has no finite default timeout — the worker blocks
> indefinitely unless you pass `timeoutMs`. The handshake defaults to
> 5 000 ms.

### Already waited

#### `SyncRPCAlreadyWaitedError`

**Trigger:** A `SyncablePromise` was consumed more than once. Each promise
has exactly one consumer — `await` / `.then` **or** `rpc.wait(...)`, not
both. Also thrown when passing a non-`SyncablePromise` to `rpc.wait`.

**Response:**

```ts
// ❌ Wrong — consumed twice
const p = rpc.root.getUser(42);
await p;
rpc.wait([p]); // throws SyncRPCAlreadyWaitedError

// ✅ Correct — one consumer per promise
const [syncResult] = rpc.wait([rpc.root.getUser(42)]);
```

See [The SyncablePromise auto-fire semantic](#the-syncablepromise-auto-fire-semantic).

### No transport wait

#### `SyncRPCNoTransportWaitError`

**Trigger:** `rpc.wait(...)` called on a client whose transport lacks a
`wait` method — the transport wasn't created by `enableSyncClient`.

**Response:**

```ts
// ❌ Wrong
const rpc = new RPCClient(rawTransport);
rpc.wait([...]); // throws SyncRPCNoTransportWaitError

// ✅ Correct
const syncTransport = await enableSyncClient(rawTransport);
const rpc = new RPCClient(syncTransport);
rpc.wait([...]); // works
```

### Reentrancy

#### `SyncRPCReentrancyError`

**Trigger:** A host method invoked during a sync batch called back into
the same client — a reentrant call that would deadlock `Atomics.wait`.

**Response:** Restructure the host API to avoid calling back into the
worker during a sync batch. Use the async path for callback legs.

### Iframe bridge errors

#### `SyncRPCIframeBridgeError`

**Trigger:** Setup or operation of an iframe bridge failed. Common causes:

| Condition | Message snippet |
|---|---|
| SAB copied across cross-origin boundary | `hs-res carried ArrayBuffer instead of SharedArrayBuffer` |
| Malformed handshake response | `hs-res carried malformed SAB fields` |
| `parentOrigin` is `'null'` (opaque) | `parentOrigin is "null" (opaque)` |
| Relay invoked from top-level window | `window.parent === window` |
| No usable `window.addEventListener` | `no usable window.addEventListener` |
| Broker context not cross-origin isolated | `this context is not crossOriginIsolated` |
| Transferables sent without sidecar | `no sidecar channel was established` |

**Response:**

1. Verify every document in the chain is
   [cross-origin isolated](#cross-origin-isolation).
2. For same-origin relays: confirm `parentOrigin` matches exactly.
   Sandboxed iframes without `allow-same-origin` produce opaque `'null'`
   origin — use `createIframeBrokerBridge` instead.
3. For cross-origin brokers: confirm the iframe itself serves COOP/COEP.
4. Check `messageerror` listeners (see [Debugging tips](#debugging-tips)).

### Payload too large

#### `SyncRPCPayloadTooLargeError`

**Trigger:** Reserved for future hard payload limits. Under v1, payloads
chunk transparently — no size triggers this error today.

The class is in the public surface for **forward compatibility**: future
memory-budget limits may wire a throw site. Code that catches
`SyncRPCPayloadTooLargeError` proactively will work without changes.

### Response transferable

#### `SyncRPCResponseTransferableError`

**Trigger:** A host method returned a `Transferable` (`ArrayBuffer`,
`MessagePort`, etc.) from a sync call. Response-side transferables can't
be serialized into the SAB — they'd silently corrupt to `{}`. This error
prevents that corruption.

**Response:** Restructure the host method to avoid returning raw
transferables. Return a serializable copy (e.g., `new Uint8Array(buffer)`
instead of the `ArrayBuffer`), or return a handle and retrieve the value
via a subsequent async call.

Response-side transferable transfer is planned for a future milestone.

---

## Cross-origin isolation

`SharedArrayBuffer` requires **cross-origin isolation** on every context in
the chain. Two HTTP headers on every document:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Verification

```js
console.log('COI:', globalThis.crossOriginIsolated); // must be true
console.log('SAB:', typeof SharedArrayBuffer !== 'undefined'); // must be true
```

`supportsSync()` from `mixed-signals/sync` performs both checks (plus the
worker-context check) in one call.

### Required headers by context

| Context | Headers needed |
|---|---|
| Parent page | `COOP: same-origin` + `COEP: require-corp` |
| Same-origin iframe | Inherits from parent if same-origin; explicit recommended |
| Cross-origin iframe (broker) | **Must** serve its own `COOP: same-origin` + `COEP: require-corp` |
| Worker script | Inherits isolation from the spawning document |

### Common gotchas

**CORP on subresources.** `COEP: require-corp` means every subresource
must either be same-origin or carry
`Cross-Origin-Resource-Policy: cross-origin`. Missing CORP on a single
`<script>`, `<img>`, or fetch breaks isolation for the entire page.

```http
# On every cross-origin subresource server:
Cross-Origin-Resource-Policy: cross-origin
```

**Sandboxed iframes.** An iframe with `sandbox` but without
`allow-same-origin` gets opaque `'null'` origin. SABs cannot cross
opaque-origin boundaries. Either add `allow-same-origin` or use
`createIframeBrokerBridge` (confines SAB to the iframe's agent cluster).

**`credentialless` COEP.** `COEP: credentialless` avoids the CORP
requirement on subresources. It enables `crossOriginIsolated` in most
browsers — use it when you can't add CORP headers to third-party resources.

**DevTools check.** Chrome DevTools → Application → top frame → scroll to
"Cross-Origin Isolated". A green checkmark confirms isolation.

---

## Debugging tips

### Attach `messageerror` listeners

`messageerror` fires when a `postMessage` payload can't be deserialized —
the most common symptom of a broken SAB transfer.

```ts
// On the worker:
self.addEventListener('messageerror', (e) => {
  console.error('Worker messageerror:', e);
});

// On the iframe:
window.addEventListener('messageerror', (e) => {
  console.error('Iframe messageerror:', e);
});
```

If `messageerror` fires during the handshake, the SAB transfer failed.
Check [Cross-origin isolation](#cross-origin-isolation) and
[Iframe bridge errors](#iframe-bridge-errors).

### SAB transfer verification

If `enableSyncClient` rejects with `SyncRPCIframeBridgeError` mentioning
`"ArrayBuffer instead of SharedArrayBuffer"`, the SAB was copied across a
cross-origin agent-cluster boundary and lost its shared backing. This means
a context in the chain is either not same-origin or not cross-origin
isolated.

### Error interpretation

Every sync RPC error includes a `docs/sync-mode.md#<anchor>` pointer in
its message. Follow the anchor to the relevant section in this document.

```ts
catch (e) {
  switch ((e as Error).name) {
    case 'SyncRPCTimeoutError':        // → #timeout
    case 'SyncRPCAlreadyWaitedError':  // → #already-waited
    case 'SyncRPCIframeBridgeError':   // → #iframe-bridge-errors
    // ...
  }
}
```

### IframeBridge inspection

Both `createIframeRelayBridge` and `createIframeBrokerBridge` return
`server` and `client` transport façades for **passive inspection**:

```ts
const bridge = createIframeRelayBridge({ worker, parentOrigin });

// Attach debug listeners (read-only — never call .send on these):
bridge.server.onMessage((data) => console.log('← host:', data));
bridge.client.onMessage((data) => console.log('← worker:', data));
```

> **Warning:** Calling `.send(...)` on façade transports bypasses the
> bridge's protocol state and may corrupt in-flight sync calls. Use them
> only for observation.

---

## Performance characteristics

Design-target latency numbers. All values are single-call wall-clock time
unless noted.

| Path | Latency |
|---|---|
| Single primitive return | 3–5 µs |
| Three primitives (amortized per call) | ~1.1 µs/call |
| Known handle return | 4–6 µs |
| First-emission object | 15–20 µs |
| 1 captured `@S` frame | 10–15 µs |
| 1 MB chunked payload | ~40–60 µs |
| Cross-origin broker (full chain) | ~100–200 µs |
| Async baseline (clean) | ~110–220 µs |
| **Async baseline (contested)** | **~2–10 ms** |

The contested async baseline is the scenario sync RPC eliminates. Under
contention, sync calls are **200–1000× faster** because they bypass the
host's macrotask queue entirely.

**Batching multiplier.** `rpc.wait([a, b, c])` amortizes round-trip
overhead. Three primitive calls in a single `rpc.wait` cost ~3.3 µs total
(~1.1 µs each) vs ~9–15 µs for three separate sync calls.

---

## Limitations

1. **Response-side transferables deferred.** Host methods cannot return raw
   `Transferable` values from sync calls — throws
   [`SyncRPCResponseTransferableError`](#response-transferable). Planned
   for a future milestone.

2. **No main-thread caller.** `Atomics.wait` is forbidden on main threads.
   Only workers can call `rpc.wait(...)`. Use `supportsSync()` to detect.

3. **Main-thread host latency is the user's responsibility.** Sync RPC
   eliminates event-loop queue wait, but the host method's own execution
   time is unchanged. A 50 ms host method still blocks the worker for 50 ms.

4. **No OffscreenWorker helper shipped.** OffscreenCanvas workers work with
   the standard Worker ↔ main recipe — construct the transport manually.

5. **Auto-fire `SyncablePromise` semantics are the default.** Unclaimed
   promises fire their async wire send after one microtask tick. No
   strict-lazy mode is planned. See
   [The SyncablePromise auto-fire semantic](#the-syncablepromise-auto-fire-semantic).

6. **Configurable `dataSabSize`.** The data SAB defaults to **64 KiB**
   (range: 4 KiB – 256 KiB). Larger reduces chunk round-trips for big
   payloads; smaller reduces memory in many-worker scenarios.

7. **Payloads larger than the SAB chunk transparently.** The chunk-state
   machine streams arbitrarily large payloads through the fixed-size SAB.
   No hard ceiling in v1. Each chunk requires one round-trip, so very large
   payloads incur proportional chunking overhead.

---

## The SyncablePromise auto-fire semantic

Every method call on a hydrated client proxy returns a `SyncablePromise` —
a `Promise` subclass whose **wire send is deferred** until first consumed.

### Three claim paths

1. **`await` / `.then` / `.catch` / `.finally`** — claims on the current
   tick. The async wire send fires immediately.

2. **`rpc.wait([p])`** — synchronous claim on the current tick for the
   sync path.

3. **Auto-fire microtask** — if nothing claims the promise within one
   microtask tick, the async send fires so it eventually resolves.

### One consumer per promise

All three paths check the same `consumed` flag. A second claim throws
[`SyncRPCAlreadyWaitedError`](#already-waited):

```ts
const p = rpc.root.getValue();
const asyncVal = await p;    // async claim
rpc.wait([p]);               // throws — already consumed
```

### Late claim after auto-fire

If you store a promise and try to `rpc.wait` it after the auto-fire
microtask has already fired:

```ts
const p = rpc.root.getValue();
await someOtherWork();        // auto-fire ran during this await
rpc.wait([p]);                // SyncRPCAlreadyWaitedError — consumed by 'auto'
```

**Best practice:** always pass freshly-created promises to `rpc.wait`:

```ts
// ✅ Sync claim wins the race with auto-fire.
const [val] = rpc.wait([rpc.root.getValue()]);
```

### Chained promises are plain Promises

`Symbol.species` is pinned to `Promise`, so `.then(...)` returns a plain
`Promise` — never a `SyncablePromise`. Chained promises are already-fired
downstream work, not `rpc.wait` candidates.

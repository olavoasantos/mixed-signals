# Test Harness

E2e testing harness for mixed-signals RPC across real runtime boundaries —
Node worker threads, browser iframes, web workers. Each environment runs
in a real isolated context with its own event loop.

## Quick Start

### Node: RPC across a worker thread

```ts
import {signal} from '@preact/signals-core';
import {createModel} from 'mixed-signals/server';
import {MixedSignalsNodeHarness} from './harness/index.ts';

const Counter = createModel('Counter', () => {
  const count = signal(0);
  return {count, increment() { count.value++; }};
});

const root = new Counter();
const harness = new MixedSignalsNodeHarness({root});
await harness.ready;

// Call a method from inside the worker — crosses the MessagePort boundary
await harness.client.evaluate(async () => {
  await globalThis.client.root.increment();
});

expect(root.count.value).toBe(1);

await harness.terminate();
```

That's it. No entry scripts, no transport wiring, no boilerplate. The
harness:
1. Spawns a worker thread with a built-in entry that creates an `RPCClient`
2. Creates an `RPC` server in the test process
3. Wires them together through the worker's `MessagePort`
4. Waits for the client to hydrate before resolving `ready`

### Browser: RPC across an iframe

```ts
import {chromium} from '@playwright/test';
import {MixedSignalsBrowserHarness} from './harness/index.ts';

const browser = await chromium.launch();
const page = await browser.newPage();

const root = new Counter();
const harness = new MixedSignalsBrowserHarness({
  page,
  root,
  topology: 'iframe',
});
await harness.ready;

await harness.client.evaluate(async () => {
  await globalThis.client.root.increment();
});

expect(root.count.value).toBe(1);

await harness.terminate();
await browser.close();
```

### Browser: RPC across a cross-origin worker relay

Three real environments: test process (server), relay iframe (bridge),
nested worker (client). This is the topology Shopify Admin uses for
extensions.

```ts
const harness = new MixedSignalsBrowserHarness({
  page,
  root,
  topology: 'cross-origin-worker-relay',
});
await harness.ready;

// This call travels: worker → iframe postMessage → Playwright binding
// → Node RPC server → response back the same path
await harness.client.evaluate(async () => {
  await globalThis.client.root.increment();
});

expect(root.count.value).toBe(1);
```

## Topologies

| Topology | `topology` value | Host | Client | Bridge |
|----------|-----------------|------|--------|--------|
| Worker thread | *(Node only)* | test process | worker_threads Worker | — |
| Iframe | `'iframe'` | test process | iframe | — |
| Cross-origin iframe | `'cross-origin-iframe'` | test process | cross-origin iframe | — |
| Same-origin worker | `'worker'` | test process | web worker | auto-relay |
| Cross-origin relay | `'cross-origin-worker-relay'` | test process | nested worker | relay iframe |
| Cross-origin broker | `'cross-origin-worker-broker'` | test process | nested worker | broker iframe |

## What's available inside `evaluate()`

Every environment has `globalThis.client` — a connected `RPCClient`:

```ts
await harness.client.evaluate(async () => {
  const client = globalThis.client;

  // Call methods (crosses the wire)
  await client.root.increment();

  // Read signal state
  const count = client.root.count.peek();

  // Subscribe to signal updates
  client.root.count.subscribe((value) => {
    console.log('count changed:', value);
  });

  // Check class identity
  client.root instanceof client.classOf('Counter');
});
```

## Custom Entry Scripts

If you need custom setup (middleware, extra APIs, non-standard transport),
pass your own entry:

```ts
const harness = new MixedSignalsNodeHarness({
  root: new Counter(),
  clientEntry: './my-custom-worker.ts',
});
```

Your entry must expose `globalThis.client` as the `RPCClient` and follow
the entry script protocol (see below).

## Cross-Origin Isolation

For sync RPC testing (SharedArrayBuffer / Atomics):

```ts
const ctx = await browser.newContext({ignoreHTTPSErrors: true});
const page = await ctx.newPage();

const harness = new MixedSignalsBrowserHarness({
  page,
  root,
  topology: 'cross-origin-worker-broker',
  crossOriginIsolation: {enabled: true},
  hostOrigin: 'https://host.test',
  clientOrigin: 'https://client.test',
});
```

## Generic Harness (protocol-agnostic)

The mixed-signals harness classes are built on top of the generic
`NodeTestHarness` and `BrowserTestHarness`, which know nothing about
mixed-signals. Use these directly if you're testing a different protocol:

```ts
import {NodeTestHarness} from './harness/index.ts';

const harness = new NodeTestHarness({
  client: {entry: './my-custom-worker.ts'},
});
await harness.ready;

// Raw MessagePort-shaped channel
harness.host.postMessage({type: 'ping'});
harness.host.onmessage = (ev) => console.log(ev.data);

// Run code inside the worker
await harness.client.evaluate(() => 1 + 1);
```

Browser topologies use preset factories:

```ts
import {BrowserTestHarness, topologies} from './harness/index.ts';

const harness = new BrowserTestHarness({
  page,
  ...topologies.iframe({clientEntry: './my-iframe.ts'}),
});
```

## Entry Script Protocol

If writing custom entry scripts:

### Node worker

| Channel | What |
|---------|------|
| `parentPort` | Eval side-channel: `{__type__: 'eval'}` → `{__type__: 'evalResult'}`. Post `{__type__: 'ready'}` when done. |
| `workerData.port` | Data channel (`MessagePort`). Wire your transport here. |

### Browser iframe

| Global | What |
|--------|------|
| `__port` | MessagePort-shaped channel. Wire your transport here. |

### Browser worker

| Channel | What |
|---------|------|
| `self` | Eval side-channel + data channel. Discriminate by `data.__type__`. |

### Bridge (relay/broker)

| Global | What |
|--------|------|
| `__port` | Channel to test process |
| `__WORKER_URL__` | Worker script URL |
| `__worker__` | Must store the Worker instance here |

## File Structure

```
test/harness/
├── types.ts                    Core interfaces
├── env/
│   ├── port-channel.ts         Reusable MessagePort state machine
│   ├── route-pattern.ts        HTML route regex helper
│   ├── test-process.ts         In-process env
│   ├── node-worker.ts          Node worker_threads env
│   ├── browser-main-frame.ts   Playwright main frame env
│   ├── browser-iframe.ts       Playwright iframe env
│   └── browser-worker.ts       Playwright worker envs
├── node-harness.ts             NodeTestHarness (generic)
├── browser-harness.ts          BrowserTestHarness (generic)
├── mixed-signals-harness.ts    MixedSignals*Harness + transport adapters
├── topologies.ts               Preset topology factories
├── bundle.ts                   tsdown IIFE bundler
├── index.ts                    Barrel export
├── __entries__/                Built-in RPC client entry scripts
│   ├── node-rpc-client.ts
│   ├── browser-iframe-rpc-client.ts
│   └── browser-worker-rpc-client.ts
└── __fixtures__/               Test-only entry scripts
```

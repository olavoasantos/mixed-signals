import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {
  TestHarness,
  TestHarnessEnv,
  PlaywrightPage,
  NodeTestHarnessOptions,
  BrowserTestHarnessOptions,
  CrossOriginIsolationConfig,
} from './types.ts';
import type {Transport, RawTransport, StringTransport} from '../../shared/protocol.ts';
import {RPC, type RPCOptions} from '../../server/rpc.ts';
import {enableSyncServer, type SyncServerTransport} from '../../sync/server.ts';
import {NodeTestHarness} from './node-harness.ts';
import {BrowserTestHarness} from './browser-harness.ts';
import * as topologies from './topologies.ts';

const ENTRIES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__entries__');

// ─── Transport adapters ─────────────────────────────────────────────────────

/**
 * Adapt a TestHarnessEnv channel into a mixed-signals StringTransport.
 */
export function createStringTransport(env: TestHarnessEnv): StringTransport {
  return {
    send(data: string) {
      env.postMessage(data);
    },
    onMessage(cb) {
      env.addEventListener('message', (ev) => {
        cb({toString: () => String(ev.data)});
      });
      env.start();
    },
    ready: env.ready,
  };
}

/**
 * Adapt a TestHarnessEnv channel into a mixed-signals RawTransport.
 */
export function createRawTransport(env: TestHarnessEnv): RawTransport {
  return {
    mode: 'raw',
    send(data: unknown, _ctx?: any) {
      env.postMessage(data);
    },
    onMessage(cb) {
      env.addEventListener('message', (ev) => {
        cb(ev.data);
      });
      env.start();
    },
    ready: env.ready,
  };
}

/**
 * Convenience: pick raw vs string transport.
 */
export function createTransport(
  env: TestHarnessEnv,
  mode?: 'raw' | 'string',
): Transport {
  return mode === 'raw' ? createRawTransport(env) : createStringTransport(env);
}

// ─── MixedSignalsNodeHarness ────────────────────────────────────────────────

/**
 * Server-side sync options passed to `enableSyncServer`.
 */
export interface SyncServerOptions {
  /** Size in bytes for the data SharedArrayBuffer. */
  dataSabSize?: number;
  /** Called when a worker dies mid-call. */
  onClientDead?: (clientId: string) => void;
}

export interface MixedSignalsNodeHarnessOptions {
  /** The root object for the RPC server. */
  root: object;
  /** RPC server options (retention policy, etc.). */
  rpcOptions?: RPCOptions;
  /**
   * Custom client entry script. Omit to use the built-in entry that
   * auto-creates an RPCClient on workerData.port.
   */
  clientEntry?: string;
  /**
   * Enable sync RPC (SAB + Atomics). Pass `true` for defaults or
   * a `SyncServerOptions` object to customize. When enabled:
   * - The default client entry uses `enableSyncClient` + `RPCClient`.
   * - The host transport is wrapped with `enableSyncServer`.
   * - The transport mode is `raw` (not string).
   */
  sync?: boolean | SyncServerOptions;
}

/**
 * Mixed-signals RPC harness for Node.js topologies.
 *
 * Creates an RPC server in the test process wired to a worker thread
 * running an RPCClient. No entry script needed — the built-in entry
 * auto-creates the client and exposes it as `globalThis.client`.
 *
 * When `sync: true`, the client entry uses `enableSyncClient` and the
 * host transport is wrapped with `enableSyncServer`, giving the client
 * a `wait()` method backed by SAB + Atomics.
 *
 * @example
 * ```ts
 * // Async mode (default)
 * const harness = new MixedSignalsNodeHarness({root: new Counter()});
 * await harness.ready;
 *
 * await harness.client.evaluate(async () => {
 *   await globalThis.client.root.increment();
 * });
 *
 * // Sync mode
 * const syncHarness = new MixedSignalsNodeHarness({root: new Counter(), sync: true});
 * await syncHarness.ready;
 *
 * await syncHarness.client.evaluate(() => {
 *   const [value] = globalThis.client.wait([globalThis.client.root.add(2, 3)]);
 *   return value;
 * });
 * ```
 */
export class MixedSignalsNodeHarness implements TestHarness {
  readonly rpc: RPC;
  readonly root: any;
  readonly host: TestHarnessEnv;
  readonly client: TestHarnessEnv;
  readonly bridge?: undefined;
  readonly ready: Promise<void>;

  private _harness: NodeTestHarness;
  private _clientId = 'c1';
  private _syncTransport?: SyncServerTransport;

  constructor(options: MixedSignalsNodeHarnessOptions) {
    const syncOpts = options.sync;
    const isSync = !!syncOpts;
    const resolvedSyncOpts: SyncServerOptions | undefined =
      isSync ? (typeof syncOpts === 'object' ? syncOpts : {}) : undefined;
    const defaultEntry = isSync ? 'node-sync-rpc-client.ts' : 'node-rpc-client.ts';
    const entry = options.clientEntry ?? resolve(ENTRIES_DIR, defaultEntry);

    this._harness = new NodeTestHarness({
      client: {entry},
    });

    this.host = this._harness.host;
    this.client = this._harness.client;
    this.root = options.root;
    this.rpc = new RPC(options.root, options.rpcOptions);

    // Wire RPC server to the host channel.
    // Sync mode uses a raw transport wrapped with enableSyncServer;
    // async mode uses a string transport directly.
    if (isSync) {
      const rawTransport = createRawTransport(this.host);
      this._syncTransport = enableSyncServer(rawTransport, {
        dataSabSize: resolvedSyncOpts?.dataSabSize,
        clientId: this._clientId,
        onClientDead: resolvedSyncOpts?.onClientDead,
      });
      this.rpc.addClient(this._syncTransport, this._clientId);
    } else {
      const transport = createStringTransport(this.host);
      this.rpc.addClient(transport, this._clientId);
    }

    // Ready when the harness is ready AND the RPCClient has hydrated
    this.ready = this._harness.ready.then(async () => {
      await this.client.evaluate(async () => {
        await (globalThis as any).client.ready;
      });
    });
  }

  /**
   * The sync server transport (only available when `sync: true`).
   * Provides `markDead()` for teardown tests.
   */
  get syncTransport(): SyncServerTransport | undefined {
    return this._syncTransport;
  }

  async terminate(): Promise<void> {
    this.rpc.removeClient(this._clientId);
    await this._harness.terminate();
  }
}

// ─── MixedSignalsBrowserHarness ─────────────────────────────────────────────

/**
 * Browser topology shorthand. Determines which built-in entry scripts
 * to use and how to configure the BrowserTestHarness.
 */
export type MixedSignalsBrowserTopology =
  | 'iframe'
  | 'cross-origin-iframe'
  | 'worker'
  | 'cross-origin-worker-relay'
  | 'cross-origin-worker-broker';

export interface MixedSignalsBrowserHarnessOptions {
  /** Playwright Page instance. */
  page: PlaywrightPage;
  /** The root object for the RPC server. */
  root: object;
  /** Which topology to use. @default 'iframe' */
  topology?: MixedSignalsBrowserTopology;
  /** RPC server options. */
  rpcOptions?: RPCOptions;
  /** Cross-Origin Isolation config. */
  crossOriginIsolation?: CrossOriginIsolationConfig;
  /**
   * Custom client entry script. Overrides the built-in entry.
   * Must expose `globalThis.client` as the RPCClient.
   */
  clientEntry?: string;
  /**
   * Custom bridge entry script. Only used for relay/broker topologies.
   * Must create __worker__ and forward messages.
   */
  bridgeEntry?: string;
  /** Origin overrides. */
  hostOrigin?: string;
  clientOrigin?: string;
  bridgeOrigin?: string;
}

/**
 * Mixed-signals RPC harness for browser topologies via Playwright.
 *
 * Creates an RPC server in the test process wired to a browser environment
 * running an RPCClient. No entry scripts needed — built-in entries
 * auto-create the client.
 *
 * @example
 * ```ts
 * const harness = new MixedSignalsBrowserHarness({
 *   page,
 *   root: new Counter(),
 *   topology: 'iframe',
 * });
 * await harness.ready;
 *
 * await harness.client.evaluate(async () => {
 *   await globalThis.client.root.increment();
 * });
 *
 * expect(harness.root.count.value).toBe(1);
 * ```
 */
export class MixedSignalsBrowserHarness implements TestHarness {
  readonly rpc: RPC;
  readonly root: any;
  readonly host: TestHarnessEnv;
  readonly client: TestHarnessEnv;
  readonly bridge?: TestHarnessEnv;
  readonly ready: Promise<void>;

  private _harness: BrowserTestHarness;
  private _clientId = 'c1';

  constructor(options: MixedSignalsBrowserHarnessOptions) {
    const topo = options.topology ?? 'iframe';

    const clientEntry = options.clientEntry ?? this._defaultClientEntry(topo);
    const bridgeEntry = options.bridgeEntry ?? resolve(ENTRIES_DIR, '../__fixtures__/browser-relay-entry.ts');

    const harnessOptions: BrowserTestHarnessOptions = {
      page: options.page,
      crossOriginIsolation: options.crossOriginIsolation,
      ...this._buildTopology(topo, clientEntry, bridgeEntry, options),
    };

    this._harness = new BrowserTestHarness(harnessOptions);

    this.host = this._harness.host;
    this.client = this._harness.client;
    this.bridge = this._harness.bridge;
    this.root = options.root;
    this.rpc = new RPC(options.root, options.rpcOptions);

    // Wire RPC server to the host channel
    const transport = createStringTransport(this.host);
    this.rpc.addClient(transport, this._clientId);

    // Ready when harness is ready AND RPCClient has hydrated
    this.ready = this._harness.ready.then(async () => {
      await this.client.evaluate(async () => {
        await (globalThis as any).client.ready;
      });
    });
  }

  private _defaultClientEntry(topo: MixedSignalsBrowserTopology): string {
    switch (topo) {
      case 'iframe':
      case 'cross-origin-iframe':
        return resolve(ENTRIES_DIR, 'browser-iframe-rpc-client.ts');
      case 'worker':
      case 'cross-origin-worker-relay':
      case 'cross-origin-worker-broker':
        return resolve(ENTRIES_DIR, 'browser-worker-rpc-client.ts');
    }
  }

  private _buildTopology(
    topo: MixedSignalsBrowserTopology,
    clientEntry: string,
    bridgeEntry: string,
    options: MixedSignalsBrowserHarnessOptions,
  ): Omit<BrowserTestHarnessOptions, 'page' | 'crossOriginIsolation'> {
    switch (topo) {
      case 'iframe':
        return topologies.iframe({
          clientEntry,
          clientOrigin: options.clientOrigin,
          hostOrigin: options.hostOrigin,
        });
      case 'cross-origin-iframe':
        return topologies.crossOriginIframe({
          clientEntry,
          clientOrigin: options.clientOrigin,
          hostOrigin: options.hostOrigin,
        });
      case 'worker':
        return topologies.sameOriginWorker({
          clientEntry,
          hostOrigin: options.hostOrigin,
        });
      case 'cross-origin-worker-relay':
        return topologies.crossOriginWorkerRelay({
          clientEntry,
          bridgeEntry,
          bridgeOrigin: options.bridgeOrigin,
          hostOrigin: options.hostOrigin,
        });
      case 'cross-origin-worker-broker':
        return topologies.crossOriginWorkerBroker({
          clientEntry,
          bridgeEntry,
          bridgeOrigin: options.bridgeOrigin,
          hostOrigin: options.hostOrigin,
        });
    }
  }

  async terminate(): Promise<void> {
    this.rpc.removeClient(this._clientId);
    await this._harness.terminate();
  }
}

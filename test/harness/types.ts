/**
 * A message event compatible with the MessagePort spec.
 */
export interface MessageEventLike {
  readonly data: unknown;
}

/**
 * Listener for message events.
 */
export type MessageListener = (ev: MessageEventLike) => void;

/**
 * An isolated execution environment within a test harness.
 *
 * Each environment provides:
 * - `evaluate()` to run code inside the environment (like Playwright's page.evaluate)
 * - A MessagePort-shaped channel for bidirectional messaging with the test process
 * - Lifecycle management (ready, close)
 */
export interface TestHarnessEnv {
  /** Resolves when the environment is fully initialized and ready. */
  readonly ready: Promise<void>;

  /** Run a function or code string in this environment and return the result. */
  evaluate<R>(fn: (...args: any[]) => R | Promise<R>, ...args: any[]): Promise<Awaited<R>>;
  evaluate(code: string): Promise<unknown>;

  // --- MessagePort-shaped channel ---

  /** Handler for incoming messages. Setting this implicitly calls start(). */
  onmessage: MessageListener | null;
  /** Register a message listener. Does NOT implicitly start the port. */
  addEventListener(type: "message", fn: MessageListener): void;
  /** Remove a message listener. */
  removeEventListener(type: "message", fn: MessageListener): void;
  /** Begin dispatching queued messages. */
  start(): void;
  /** Send a message to this environment. */
  postMessage(data: unknown): void;
  /** Close the environment's message channel. */
  close(): void;
}

/**
 * A test harness that orchestrates multiple isolated environments.
 */
export interface TestHarness {
  /** Resolves when all environments are ready. */
  readonly ready: Promise<void>;
  /** The host environment (server-side / main context). */
  readonly host: TestHarnessEnv;
  /** The client environment (consumer-side). */
  readonly client: TestHarnessEnv;
  /** Optional bridge environment (relay or broker between host and client). */
  readonly bridge?: TestHarnessEnv;
  /** Terminate all environments and clean up resources. */
  terminate(): Promise<void>;
}

// --- Node harness options ---

export interface NodeWorkerEnvConfig {
  /** Path to the TypeScript entry file for the worker. */
  entry: string;
}

export interface NodeTestHarnessOptions {
  /** Host configuration. Omit to use the test process as the host. */
  host?: NodeWorkerEnvConfig;
  /** Client worker configuration. */
  client: NodeWorkerEnvConfig;
}

// --- Browser environment descriptors ---

export interface MainFrameEnvConfig {
  type: "main-frame";
  /** Path to the TypeScript entry file. */
  entry: string;
  /** Origin for route interception. @default 'http://host.test' */
  origin?: string;
}

export interface WorkerEnvConfig {
  type: "worker";
  /** Path to the TypeScript entry file. */
  entry: string;
}

export interface IframeEnvConfig {
  type: "iframe";
  /** Path to the TypeScript entry file for the iframe. */
  entry: string;
  /** Origin for route interception. @default auto-generated */
  origin?: string;
  /** Nested worker environment inside this iframe. */
  client?: WorkerEnvConfig;
}

export type BrowserEnvConfig = MainFrameEnvConfig | IframeEnvConfig | WorkerEnvConfig;

// --- Minimal Playwright type surface ---
// Defined here so the harness doesn't import Playwright types directly.

export interface PlaywrightPage {
  goto(url: string, options?: unknown): Promise<unknown>;
  route(
    url: string | RegExp,
    handler: (route: PlaywrightRoute) => void | Promise<void>,
  ): Promise<void>;
  exposeBinding(
    name: string,
    callback: (source: PlaywrightBindingSource, ...args: any[]) => unknown,
    options?: { handle?: boolean },
  ): Promise<void>;
  addInitScript(script: (() => void) | string | { path?: string; content?: string }): Promise<void>;
  evaluate<R>(pageFunction: string | ((...args: any[]) => R | Promise<R>), arg?: any): Promise<R>;
  frames(): PlaywrightFrame[];
  close(): Promise<void>;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  waitForSelector(selector: string, options?: unknown): Promise<unknown>;
}

export interface PlaywrightRoute {
  fulfill(options: {
    status?: number;
    contentType?: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<void>;
}

export interface PlaywrightBindingSource {
  frame: PlaywrightFrame;
}

export interface PlaywrightFrame {
  url(): string;
  evaluate<R>(pageFunction: string | ((...args: any[]) => R | Promise<R>), arg?: any): Promise<R>;
  isDetached(): boolean;
}

// --- Browser configuration ---

/**
 * Cross-Origin Isolation headers configuration.
 * When enabled, all route responses include COOP and COEP headers,
 * enabling SharedArrayBuffer access for sync RPC testing.
 */
export interface CrossOriginIsolationConfig {
  /**
   * Enable Cross-Origin Isolation headers on all responses.
   * Sets `Cross-Origin-Opener-Policy: same-origin` and
   * `Cross-Origin-Embedder-Policy: require-corp`.
   * @default false
   */
  enabled: boolean;
  /**
   * Override the COOP header value.
   * @default 'same-origin'
   */
  coop?: string;
  /**
   * Override the COEP header value.
   * @default 'require-corp'
   */
  coep?: string;
}

// --- Browser harness options ---

export interface BrowserTestHarnessOptions {
  /** Playwright Page instance. */
  page: PlaywrightPage;
  /** Host configuration. Omit to use the test process as the host. */
  host?: MainFrameEnvConfig;
  /** Client environment configuration. */
  client?: BrowserEnvConfig;
  /** Bridge environment configuration (must be an iframe, may contain a nested worker). */
  bridge?: IframeEnvConfig;
  /**
   * Cross-Origin Isolation configuration.
   * When enabled, all route responses include COOP/COEP headers.
   * Required for SharedArrayBuffer / sync RPC testing.
   */
  crossOriginIsolation?: CrossOriginIsolationConfig;
}

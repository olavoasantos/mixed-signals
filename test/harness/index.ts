// Core types
export type { TestHarness, TestHarnessEnv, MessageEventLike, MessageListener } from "./types.ts";

// Option types
export type {
  NodeTestHarnessOptions,
  NodeWorkerEnvConfig,
  BrowserTestHarnessOptions,
  BrowserEnvConfig,
  MainFrameEnvConfig,
  IframeEnvConfig,
  WorkerEnvConfig,
  CrossOriginIsolationConfig,
} from "./types.ts";

// Playwright types (for consumers who need them)
export type {
  PlaywrightPage,
  PlaywrightFrame,
  PlaywrightRoute,
  PlaywrightBindingSource,
} from "./types.ts";

// Harness classes
export { NodeTestHarness } from "./node-harness.ts";
export { BrowserTestHarness } from "./browser-harness.ts";

// Channel primitive
export { PortChannel, createPortChannelPair } from "./env/port-channel.ts";

// Environment classes (for advanced usage)
export { TestProcessEnv } from "./env/test-process.ts";
export { NodeWorkerEnv } from "./env/node-worker.ts";
export { BrowserMainFrameEnv } from "./env/browser-main-frame.ts";
export { BrowserIframeEnv } from "./env/browser-iframe.ts";
export { BrowserWorkerEnv, BrowserNestedWorkerEnv } from "./env/browser-worker.ts";

// Preset topologies
export * as topologies from "./topologies.ts";

// Mixed-signals integration
export {
  createStringTransport,
  createRawTransport,
  createTransport,
  MixedSignalsNodeHarness,
  MixedSignalsBrowserHarness,
  type MixedSignalsNodeHarnessOptions,
  type MixedSignalsBrowserHarnessOptions,
  type MixedSignalsBrowserTopology,
  type SyncServerOptions,
} from "./mixed-signals-harness.ts";

// Bundle utilities
export { bundleEntry, transformForEvaluate, clearBundleCache } from "./bundle.ts";

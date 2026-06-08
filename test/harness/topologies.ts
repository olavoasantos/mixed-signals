import type { BrowserTestHarnessOptions } from "./types.ts";

type TopologyConfig = Omit<BrowserTestHarnessOptions, "page">;

interface BaseEntryConfig {
  hostEntry?: string;
  clientEntry: string;
}

interface OriginConfig {
  hostOrigin?: string;
  clientOrigin?: string;
}

interface BridgeEntryConfig extends BaseEntryConfig {
  bridgeEntry: string;
  bridgeOrigin?: string;
}

/**
 * Iframe topology.
 *
 * Host = test process (default) or main frame.
 * Client = iframe. Same-origin vs cross-origin depends on the origins
 * the caller provides — the topology structure is identical either way.
 */
export function iframe(opts: BaseEntryConfig & OriginConfig): TopologyConfig {
  const hostOrigin = opts.hostOrigin ?? "http://host.test";
  // Note: In Playwright's route-interception model, true same-origin iframes
  // require path-based routing (not implemented yet). This preset uses separate
  // origins that Playwright treats as same-context for testing purposes.
  // For real same-origin testing, provide matching origins with a custom host
  // entry that handles path-based routing.
  const clientOrigin = opts.clientOrigin ?? "http://app.test";
  return {
    ...(opts.hostEntry
      ? { host: { type: "main-frame" as const, entry: opts.hostEntry, origin: hostOrigin } }
      : {}),
    client: {
      type: "iframe" as const,
      entry: opts.clientEntry,
      origin: clientOrigin,
    },
  };
}

/**
 * Cross-origin iframe topology.
 *
 * Host = test process (default) or main frame.
 * Client = cross-origin iframe.
 */
export function crossOriginIframe(opts: BaseEntryConfig & OriginConfig): TopologyConfig {
  return {
    ...(opts.hostEntry
      ? {
          host: {
            type: "main-frame" as const,
            entry: opts.hostEntry,
            origin: opts.hostOrigin ?? "http://host.test",
          },
        }
      : {}),
    client: {
      type: "iframe" as const,
      entry: opts.clientEntry,
      origin: opts.clientOrigin ?? "http://client.test",
    },
  };
}

/**
 * Same-origin worker topology.
 *
 * Host = test process (default) or main frame.
 * Client = Web Worker spawned by the main frame.
 */
export function sameOriginWorker(
  opts: BaseEntryConfig & Pick<OriginConfig, "hostOrigin">,
): TopologyConfig {
  return {
    ...(opts.hostEntry
      ? {
          host: {
            type: "main-frame" as const,
            entry: opts.hostEntry,
            origin: opts.hostOrigin ?? "http://host.test",
          },
        }
      : {}),
    client: {
      type: "worker" as const,
      entry: opts.clientEntry,
    },
  };
}

/**
 * Cross-origin worker relay topology.
 *
 * Host = test process (default) or main frame.
 * Bridge = cross-origin iframe acting as a dumb relay.
 * Client = Web Worker spawned inside the bridge iframe.
 *
 * The bridge's entry script creates the worker and forwards messages
 * bidirectionally without inspecting payloads.
 */
export function crossOriginWorkerRelay(opts: BridgeEntryConfig & OriginConfig): TopologyConfig {
  return {
    ...(opts.hostEntry
      ? {
          host: {
            type: "main-frame" as const,
            entry: opts.hostEntry,
            origin: opts.hostOrigin ?? "http://host.test",
          },
        }
      : {}),
    bridge: {
      type: "iframe" as const,
      entry: opts.bridgeEntry,
      origin: opts.bridgeOrigin ?? "http://bridge.test",
      client: {
        type: "worker" as const,
        entry: opts.clientEntry,
      },
    },
  };
}

/**
 * Cross-origin worker broker topology.
 *
 * Host = test process (default) or main frame.
 * Bridge = cross-origin iframe acting as an active broker.
 * Client = Web Worker spawned inside the bridge iframe.
 *
 * The bridge's entry script creates the worker and actively brokers
 * between the host (async postMessage) and client (SAB + Atomics).
 * Used for sync RPC across origin boundaries.
 */
export function crossOriginWorkerBroker(opts: BridgeEntryConfig & OriginConfig): TopologyConfig {
  // Same structure as relay — the difference is in the entry scripts.
  // The broker entry script actively participates in the protocol,
  // while the relay entry script is a dumb pipe.
  return crossOriginWorkerRelay(opts);
}

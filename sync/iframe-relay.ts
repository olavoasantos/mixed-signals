/**
 * Cross-origin iframe postMessage forwarder. Wires bidirectional
 * `postMessage` forwarding between the iframe's parent window and the
 * worker the iframe spawned. The iframe is a *dumb pipe*: it never
 * blocks (only the leaf worker calls `Atomics.wait`) and never
 * inspects payloads.
 *
 * Setup invariants the caller MUST satisfy:
 *   - The parent page, this iframe, and the spawned worker are all
 *     `crossOriginIsolated` (COOP `same-origin` + COEP `require-corp`).
 *   - `parentOrigin` matches `window.parent`'s origin exactly.
 *   - The worker is same-origin to the iframe (so the iframe can
 *     `new Worker(url)` without an extra fetch hop).
 *
 * The SABs (control + data) flow through this relay during the sync
 * transport handshake: the parent sends `{__sync: 'hs-res', control,
 * data}` via the parent→iframe channel; the relay forwards verbatim to
 * the worker. `postMessage` between cross-origin-isolated contexts
 * preserves `SharedArrayBuffer` references rather than structured-
 * cloning them, so the same backing memory is reachable from all three
 * contexts.
 */
export interface CreateSyncIframeRelayOptions {
  /** The worker the iframe spawned. */
  worker: Worker;
  /** `targetOrigin` for `window.parent.postMessage(...)`. */
  parentOrigin: string;
}

export function createSyncIframeRelay(opts: CreateSyncIframeRelayOptions): {
  dispose: () => void;
} {
  const {worker, parentOrigin} = opts;

  const fromWorker = (event: MessageEvent) => {
    window.parent.postMessage(event.data, parentOrigin);
  };
  worker.addEventListener('message', fromWorker);

  const fromParent = (event: MessageEvent) => {
    // Only forward messages from our parent window; ignore everything
    // else (other frames, browser-injected messages, etc.).
    if (event.source !== window.parent) return;
    // Strict origin check — we trust ONLY the configured parent.
    if (event.origin !== parentOrigin) return;
    worker.postMessage(event.data);
  };
  window.addEventListener('message', fromParent);

  return {
    dispose() {
      worker.removeEventListener('message', fromWorker);
      window.removeEventListener('message', fromParent);
    },
  };
}

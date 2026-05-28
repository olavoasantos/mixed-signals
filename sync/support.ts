/**
 * Capability check: can this context be the *caller* side of sync RPC?
 *
 * Returns false in:
 *   - main threads (browsers — `Window` global present, no `WorkerGlobalScope`)
 *   - ServiceWorkers (`ServiceWorkerGlobalScope`)
 *   - any context without `SharedArrayBuffer`
 *   - browser contexts that aren't crossOriginIsolated
 *   - Node main thread (we want worker threads only — `isMainThread === true` means no)
 *
 * Browser DedicatedWorker / SharedWorker and Node `worker_threads` workers
 * return true.
 */
export function supportsSync(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (typeof Atomics === 'undefined') return false;

  // Browser path
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as Record<string, unknown>;

    // ServiceWorker — explicit no.
    if (typeof g.ServiceWorkerGlobalScope !== 'undefined') return false;

    // Worker context — has WorkerGlobalScope and no Window.
    const hasWorkerScope = typeof g.WorkerGlobalScope !== 'undefined';
    const hasWindow = typeof g.window !== 'undefined' && g.window === g;

    if (hasWindow) return false; // main thread

    if (hasWorkerScope) {
      // Browser worker: also require crossOriginIsolated.
      if ('crossOriginIsolated' in g && g.crossOriginIsolated === false) {
        return false;
      }
      return true;
    }
  }

  // Node path: import lazily, only if no worker scope was detected above.
  // In Node ESM, top-level await isn't available here without making this
  // function async — instead we check the global property `process` and
  // require-from-cache `node:worker_threads`. If we're in a browser bundle
  // these checks return false gracefully.
  if (
    typeof process !== 'undefined' &&
    typeof (process as {versions?: {node?: string}}).versions?.node === 'string'
  ) {
    try {
      // Synchronous require via dynamic import won't work in pure ESM, but
      // Node provides this module — eval'd require avoids bundler resolution.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wt = (globalThis as {require?: NodeRequire}).require?.(
        'node:worker_threads',
      ) as {isMainThread?: boolean} | undefined;
      if (wt && typeof wt.isMainThread === 'boolean') {
        return !wt.isMainThread;
      }
    } catch {
      // fall through
    }
  }

  return false;
}

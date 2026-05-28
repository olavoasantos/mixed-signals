/**
 * Sync RPC error hierarchy. All errors inherit from `SyncRPCError` so user
 * code can `catch (e) { if (e instanceof SyncRPCError) ... }`.
 *
 * Prototype scope: messages are deliberately terse. We'll flesh them out
 * (and the "point to docs" copy) when this becomes a real release.
 */

export class SyncRPCError extends Error {
  override name = 'SyncRPCError';
}

export class SyncRPCNotCrossOriginIsolatedError extends SyncRPCError {
  override name = 'SyncRPCNotCrossOriginIsolatedError';
}

/** Main thread, ServiceWorker, or no SharedArrayBuffer available. */
export class SyncRPCUnsupportedContextError extends SyncRPCError {
  override name = 'SyncRPCUnsupportedContextError';
}

export class SyncRPCTimeoutError extends SyncRPCError {
  override name = 'SyncRPCTimeoutError';
}

/** A `SyncablePromise` was consumed twice (by `await`/`.then` and then by `rpc.wait`, or vice versa). */
export class SyncRPCAlreadyWaitedError extends SyncRPCError {
  override name = 'SyncRPCAlreadyWaitedError';
}

/** The bound transport doesn't implement `wait?(calls, opts)`. */
export class SyncRPCNoTransportWaitError extends SyncRPCError {
  override name = 'SyncRPCNoTransportWaitError';
}

/** A method invoked on a sync-blocked client tried to call back into the same client. */
export class SyncRPCReentrancyError extends SyncRPCError {
  override name = 'SyncRPCReentrancyError';
}

/** SAB transfer failed somewhere in the iframe chain. */
export class SyncRPCIframeBridgeError extends SyncRPCError {
  override name = 'SyncRPCIframeBridgeError';
}

/**
 * Encoded request envelope exceeds data SAB capacity. Prototype-only:
 * once chunking lands, this becomes unreachable.
 */
export class SyncRPCPayloadTooLargeError extends SyncRPCError {
  override name = 'SyncRPCPayloadTooLargeError';
}

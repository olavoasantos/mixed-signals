/**
 * `mixed-signals/sync` — synchronous RPC for worker-side callers.
 *
 * See `.product/sync-rpc/plan.md` for prototype scope.
 */

export {
  SyncRPCError,
  SyncRPCNotCrossOriginIsolatedError,
  SyncRPCUnsupportedContextError,
  SyncRPCTimeoutError,
  SyncRPCAlreadyWaitedError,
  SyncRPCNoTransportWaitError,
  SyncRPCReentrancyError,
  SyncRPCIframeBridgeError,
  SyncRPCPayloadTooLargeError,
} from './errors.ts';

export {supportsSync} from './support.ts';

export {
  SyncablePromise,
  isSyncablePromise,
  type SyncableCallDescriptor,
} from './syncable-promise.ts';

export {createSyncTransportHost} from './transport-host.ts';
export {acceptSyncTransport} from './transport-caller.ts';

export {
  CONTROL_SAB_BYTES,
  DEFAULT_DATA_SAB_BYTES,
  MAX_DATA_SAB_BYTES,
  allocateLane,
} from './lane.ts';

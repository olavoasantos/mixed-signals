/**
 * Browser entry: iframe (relay) side of the sync RPC iframe topology.
 *
 * Spawns the worker (same-origin to this iframe) and wires
 * `createSyncIframeRelay` to forward postMessage between
 * `window.parent` and the worker. Dumb pipe — never blocks, never
 * inspects payloads. Mirrors design.md §6 (with the caveat that, per
 * the spec's origin-keyed agent clusters under COI, the parent must
 * also be same-origin to this iframe for SAB transfer to work).
 */
import {createSyncIframeRelay} from '../../../../sync/iframe-relay.ts';

const parentOrigin = (globalThis as Record<string, unknown>)
  .__PARENT_ORIGIN__ as string;
const workerUrl = (globalThis as Record<string, unknown>)
  .__WORKER_URL__ as string;

const worker = new Worker(workerUrl, {type: 'classic'});
(globalThis as Record<string, unknown>).__worker__ = worker;

createSyncIframeRelay({worker, parentOrigin});

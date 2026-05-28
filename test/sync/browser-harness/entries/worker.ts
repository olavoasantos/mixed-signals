/**
 * Browser entry: worker (caller) side of the sync RPC harness.
 *
 * Generic infrastructure — no test-specific logic. Accepts a sync
 * transport via SAB handshake, builds an `RPCClient`, exposes it as
 * `globalThis.client`, and runs an eval side-channel for the harness.
 */
import {RPCClient} from '../../../../client/rpc.ts';
import type {RawTransport} from '../../../../shared/protocol.ts';
import {acceptSyncTransport} from '../../../../sync/transport-caller.ts';

const base: RawTransport = {
  mode: 'raw',
  send(data, ctx) {
    globalThis.postMessage(data, (ctx?.transfer as any) ?? []);
  },
  onMessage(cb) {
    globalThis.addEventListener('message', (e) => {
      // Skip eval messages (the side-channel below).
      if (e.data && (e.data as {__type__?: unknown}).__type__) return;
      cb(e.data);
    });
  },
};

(async () => {
  const syncTransport = await acceptSyncTransport({base, timeoutMs: 5000});
  const client = new RPCClient(syncTransport);
  await client.ready;
  (globalThis as Record<string, unknown>).client = client;

  // Side-channel for `SyncRpcWorkerClient.workerEvaluate`. Messages
  // carry `__type__: 'eval'` to differentiate from RPC traffic on the
  // same channel.
  globalThis.addEventListener('message', (event) => {
    const msg = event.data as
      | {__type__: 'eval'; __id__: number; code: string; arg?: unknown}
      | {__type__?: string};
    if ((msg as {__type__?: string}).__type__ !== 'eval') return;
    const evalMsg = msg as {__id__: number; code: string; arg?: unknown};
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(
        'client',
        'arg',
        `return (${evalMsg.code})(client, arg);`,
      );
      Promise.resolve(fn(client, evalMsg.arg)).then(
        (value) =>
          globalThis.postMessage({
            __type__: 'evalResult',
            __id__: evalMsg.__id__,
            ok: true,
            value,
          }),
        (err: unknown) =>
          globalThis.postMessage({
            __type__: 'evalResult',
            __id__: evalMsg.__id__,
            ok: false,
            error: (err as Error)?.message ?? String(err),
          }),
      );
    } catch (err) {
      globalThis.postMessage({
        __type__: 'evalResult',
        __id__: evalMsg.__id__,
        ok: false,
        error: (err as Error)?.message ?? String(err),
      });
    }
  });

  globalThis.postMessage({__type__: 'ready'});
})();

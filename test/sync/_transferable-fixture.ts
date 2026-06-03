/**
 * Worker-side fixture for transferable round-trip tests. Runs a real
 * `RPCClient` over an `enableSyncClient`-wrapped transport and
 * dispatches sync calls that carry `Transferable` values (ArrayBuffer,
 * MessagePort) created locally in the worker.
 *
 * Commands are received via `parentPort` `{kind: 'test', data}` messages.
 * Results are posted back via `{kind: 'test', data}`.
 */
import {MessageChannel, parentPort} from 'node:worker_threads';
import {RPCClient} from '../../client/rpc.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncClient} from '../../sync/client.ts';

if (!parentPort) {
  throw new Error('_transferable-fixture must run inside a Node Worker');
}

const rpcListeners: Array<
  (data: unknown, ctx?: TransportContext) => void | Promise<void>
> = [];
const testListeners: Array<(data: unknown) => void> = [];

parentPort.on(
  'message',
  (envelope: {kind: string; data: unknown}, transferList?: unknown[]) => {
    if (envelope?.kind === 'mixed-signals') {
      for (const listener of rpcListeners) listener(envelope.data);
    } else if (envelope?.kind === 'test') {
      for (const listener of testListeners) listener(envelope.data);
    }
  },
);

const base: RawTransport = {
  mode: 'raw',
  send(data, ctx) {
    const transfer = ctx?.transfer ?? [];
    parentPort!.postMessage({kind: 'mixed-signals', data}, transfer as any);
  },
  onMessage(cb) {
    rpcListeners.push(cb);
  },
};

function sendTest(data: unknown): void {
  parentPort!.postMessage({kind: 'test', data});
}

(async () => {
  try {
    const transport = await enableSyncClient(base, {timeoutMs: 5000});
    const client = new RPCClient(transport);
    await client.ready;

    sendTest({type: 'ready'});

    testListeners.push((cmd: unknown) => {
      const c = cmd as {type: string; id: number; [k: string]: unknown};

      try {
        switch (c.type) {
          // ── Request-side transferable tests ─────────────────────────
          case 'transfer-arraybuffer': {
            // Create an ArrayBuffer locally, fill with known data.
            const buf = new ArrayBuffer(16);
            const view = new Uint8Array(buf);
            for (let i = 0; i < 16; i++) view[i] = i + 1;
            const [result] = client.wait([
              client.root.receiveBuffer(buf),
            ]);
            sendTest({
              type: 'transfer-arraybuffer-result',
              id: c.id,
              ok: true,
              result,
              callerDetached: buf.byteLength === 0,
            });
            return;
          }

          case 'transfer-empty-arraybuffer': {
            const buf = new ArrayBuffer(0);
            const [result] = client.wait([
              client.root.receiveBuffer(buf),
            ]);
            sendTest({
              type: 'transfer-empty-arraybuffer-result',
              id: c.id,
              ok: true,
              result,
              callerDetached: buf.byteLength === 0,
            });
            return;
          }

          case 'transfer-messageport': {
            // Create a MessageChannel, transfer port2 to the host.
            const ch = new MessageChannel();
            const [result] = client.wait([
              client.root.receivePort(ch.port2),
            ]);
            // Verify the host-side port is usable by listening on port1.
            const received = new Promise<string>((resolve) => {
              ch.port1.on('message', (msg: string) => resolve(msg));
              ch.port1.start();
            });
            // The host should have posted 'hello' on the received port.
            Promise.race([
              received,
              new Promise<string>((resolve) =>
                setTimeout(() => resolve('timeout'), 2000),
              ),
            ]).then((msg) => {
              sendTest({
                type: 'transfer-messageport-result',
                id: c.id,
                ok: true,
                result,
                receivedMessage: msg,
              });
              ch.port1.close();
            });
            return;
          }

          case 'transfer-mixed-args': {
            const buf = new ArrayBuffer(8);
            const view = new Uint8Array(buf);
            for (let i = 0; i < 8; i++) view[i] = 100 + i;
            const ch = new MessageChannel();
            const [result] = client.wait([
              client.root.receiveMixed(42, buf, 'hello', ch.port2),
            ]);
            ch.port1.close();
            sendTest({
              type: 'transfer-mixed-args-result',
              id: c.id,
              ok: true,
              result,
              callerBufferDetached: buf.byteLength === 0,
            });
            return;
          }

          case 'transfer-nary-batch': {
            const buf1 = new ArrayBuffer(4);
            new Uint8Array(buf1).set([1, 2, 3, 4]);
            const buf2 = new ArrayBuffer(4);
            new Uint8Array(buf2).set([5, 6, 7, 8]);
            const buf3 = new ArrayBuffer(4);
            new Uint8Array(buf3).set([9, 10, 11, 12]);

            const values = client.wait([
              client.root.receiveBuffer(buf1),
              client.root.receiveBuffer(buf2),
              client.root.receiveBuffer(buf3),
            ]);
            sendTest({
              type: 'transfer-nary-batch-result',
              id: c.id,
              ok: true,
              values,
              allDetached:
                buf1.byteLength === 0 &&
                buf2.byteLength === 0 &&
                buf3.byteLength === 0,
            });
            return;
          }

          // ── Response-side guardrail tests ───────────────────────────
          case 'response-transferable': {
            try {
              client.wait([client.root.returnBuffer()]);
              sendTest({
                type: 'response-transferable-result',
                id: c.id,
                ok: false,
                error: 'expected throw',
              });
            } catch (err) {
              sendTest({
                type: 'response-transferable-result',
                id: c.id,
                ok: true,
                errorName: (err as Error).name,
                errorMessage: (err as Error).message,
              });
            }
            return;
          }

          case 'response-transferable-nested': {
            try {
              client.wait([client.root.returnObjectWithBuffer()]);
              sendTest({
                type: 'response-transferable-nested-result',
                id: c.id,
                ok: false,
                error: 'expected throw',
              });
            } catch (err) {
              sendTest({
                type: 'response-transferable-nested-result',
                id: c.id,
                ok: true,
                errorName: (err as Error).name,
                errorMessage: (err as Error).message,
              });
            }
            return;
          }

          case 'response-transferable-batch': {
            // 3-call batch: safe, transferable, safe.
            // The transferable call (index 1) should error;
            // calls 0 and 2 should succeed.
            try {
              client.wait([
                client.root.returnSafe(),
                client.root.returnBuffer(),
                client.root.returnSafe(),
              ]);
              sendTest({
                type: 'response-transferable-batch-result',
                id: c.id,
                ok: false,
                error: 'expected throw',
              });
            } catch (err) {
              sendTest({
                type: 'response-transferable-batch-result',
                id: c.id,
                ok: true,
                errorName: (err as Error).name,
                errorMessage: (err as Error).message,
              });
            }
            return;
          }

          case 'response-transferable-deep': {
            try {
              client.wait([client.root.returnDeepBuffer()]);
              sendTest({
                type: 'response-transferable-deep-result',
                id: c.id,
                ok: false,
                error: 'expected throw',
              });
            } catch (err) {
              sendTest({
                type: 'response-transferable-deep-result',
                id: c.id,
                ok: true,
                errorName: (err as Error).name,
                errorMessage: (err as Error).message,
              });
            }
            return;
          }

          // ── Simple call for baseline ───────────────────────────────
          case 'sync-call': {
            const method = c.method as string;
            const args = (c.args ?? []) as unknown[];
            const [value] = client.wait([
              client.root[method](...args),
            ]);
            sendTest({type: 'sync-call-result', id: c.id, ok: true, value});
            return;
          }
        }
      } catch (err) {
        sendTest({
          type: 'command-error',
          id: c.id,
          error: (err as Error).message,
          errorName: (err as Error).name,
        });
      }
    });
  } catch (err) {
    sendTest({type: 'fatal', error: (err as Error).message});
  }
})();

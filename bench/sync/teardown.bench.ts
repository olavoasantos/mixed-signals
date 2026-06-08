/**
 * Worker teardown bench: wall-clock from worker.terminate() to the
 * host's onClientDead callback.
 *
 * Each iteration spawns a fresh worker because terminate is one-shot.
 * The measurement window starts immediately before worker.terminate()
 * and ends when onClientDead fires — spawn and handshake time is
 * excluded from the reported number.
 */
import {bench, describe} from 'vitest';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createModel} from '../../server/model.ts';
import {RPC} from '../../server/rpc.ts';
import {enableSyncServer} from '../../sync/server.ts';
import {createNodeWorkerBridge} from '../../sync/node-worker-bridge.ts';
import {
  NodeTestHarness,
  createRawTransport,
} from '../../test/harness/index.ts';

const SYNC_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../test/harness/__entries__/node-sync-rpc-client.ts',
);

describe('sync-rpc teardown', () => {
  bench(
    'worker_teardown_cleanup',
    async () => {
      const TeardownRoot = createModel('TeardownRoot', () => ({
        noop() {
          return true;
        },
      }));

      const clientId = 'teardown-bench';
      const rpc = new RPC(new TeardownRoot());

      const nodeHarness = new NodeTestHarness({
        client: {entry: SYNC_ENTRY},
      });

      let deadResolve!: () => void;
      const deadPromise = new Promise<void>((r) => {
        deadResolve = r;
      });

      const rawTransport = createRawTransport(nodeHarness.host);
      const syncTransport = enableSyncServer(rawTransport, {
        clientId,
        onClientDead() {
          deadResolve();
        },
      });
      rpc.addClient(syncTransport, clientId);

      await nodeHarness.ready;
      await nodeHarness.client.evaluate(async () => {
        await (globalThis as any).client.ready;
      });

      // Access the underlying Worker for death detection wiring.
      // The NodeTestHarness doesn't expose its worker publicly;
      // this is a bench-only escape hatch.
      const workerEnv = (nodeHarness as any)._clientEnv;
      const worker = workerEnv._worker;

      const bridge = createNodeWorkerBridge({
        worker,
        onDeath() {
          syncTransport.markDead(clientId);
        },
      });

      // Terminate and wait for death detection
      await worker.terminate();
      await deadPromise;

      bridge.dispose();
      rpc.removeClient(clientId);
      nodeHarness.host.close();
    },
    {iterations: 30, warmupIterations: 3},
  );
});

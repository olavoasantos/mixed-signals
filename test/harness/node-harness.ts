import type { NodeTestHarnessOptions, TestHarness, TestHarnessEnv } from "./types.ts";
import { TestProcessEnv } from "./env/test-process.ts";
import { NodeWorkerEnv } from "./env/node-worker.ts";

/**
 * Test harness for Node.js topologies.
 *
 * Default topology: host = test process, client = worker_threads Worker.
 * The host and client channels are wired bidirectionally:
 * - host.postMessage(data) → arrives at client.onmessage
 * - client.postMessage(data) → arrives at host.onmessage
 *
 * For TestProcessEnv hosts, this means host.postMessage sends to the
 * worker's data port, and worker replies arrive at host.onmessage.
 */
export class NodeTestHarness implements TestHarness {
  readonly host: TestHarnessEnv;
  readonly client: TestHarnessEnv;
  readonly bridge?: undefined;
  readonly ready: Promise<void>;

  private _clientEnv: NodeWorkerEnv;
  private _hostEnv: TestProcessEnv | NodeWorkerEnv;

  constructor(options: NodeTestHarnessOptions) {
    this._clientEnv = new NodeWorkerEnv(options.client.entry);

    if (options.host) {
      // Two-worker topology: host and client both run in separate workers.
      // The test process bridges them: host worker data port messages are
      // forwarded to the client worker's data port, and vice versa.
      // Each NodeWorkerEnv's channel.deliver already sends to its own
      // worker's data port — we don't replace that. Instead we use
      // onReceive to tap inbound messages and forward them to the peer.
      const hostEnv = new NodeWorkerEnv(options.host.entry);

      // Host worker sends → forward to client worker
      hostEnv.channel.onReceive = (data) => {
        this._clientEnv.channel.postMessage(data);
      };
      // Client worker sends → forward to host worker
      this._clientEnv.channel.onReceive = (data) => {
        hostEnv.channel.postMessage(data);
      };

      this._hostEnv = hostEnv;
    } else {
      // Test process is the host. Wire it bidirectionally to the client:
      // host.postMessage → worker's data port (via client's channel deliver)
      // worker's data port messages → host.channel.receive
      const hostEnv = new TestProcessEnv();

      // host.postMessage → send to worker's data port
      hostEnv.channel.setDeliver((data) => {
        this._clientEnv.channel.postMessage(data);
      });

      // Worker data port messages → also deliver to host
      this._clientEnv.channel.onReceive = (data) => {
        hostEnv.channel.receive(data);
      };

      this._hostEnv = hostEnv;
    }

    this.host = this._hostEnv;
    this.client = this._clientEnv;

    this.ready = Promise.all([this.host.ready, this.client.ready]).then(() => undefined);
  }

  async terminate(): Promise<void> {
    this.host.close();
    this.client.close();
    await this._clientEnv._terminate();
    if (this._hostEnv instanceof NodeWorkerEnv) {
      await this._hostEnv._terminate();
    }
  }
}

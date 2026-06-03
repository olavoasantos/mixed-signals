import { Worker, MessageChannel } from "node:worker_threads";
import { resolve } from "node:path";
import type { MessageListener, TestHarnessEnv } from "../types.ts";
import { PortChannel } from "./port-channel.ts";

/**
 * A TestHarnessEnv backed by a Node.js worker_threads Worker.
 *
 * Communication channels:
 * - Default worker channel (parentPort): eval side-channel + ready signal
 * - Transferred MessagePort (workerData.port): data channel for RPC messages
 *
 * The MessagePort-shaped API delegates to a composed PortChannel whose
 * outbound path sends to the worker's data port.
 */
export class NodeWorkerEnv implements TestHarnessEnv {
  readonly ready: Promise<void>;
  readonly channel: PortChannel;

  private _worker: Worker;
  private _dataChannel: MessageChannel;
  private _nodePort: MessagePort;
  private _evalId = 0;

  constructor(entry: string) {
    const absolute = resolve(entry);
    this._dataChannel = new MessageChannel();
    this._nodePort = this._dataChannel.port1;

    // PortChannel: outbound goes to worker's data port
    this.channel = new PortChannel((data) => {
      this._nodePort.postMessage(data);
    });

    this._worker = new Worker(absolute, {
      workerData: { port: this._dataChannel.port2 },
      transferList: [this._dataChannel.port2],
    });

    // Inbound: worker's data port messages go to channel.receive
    this._nodePort.on("message", (data: unknown) => {
      this.channel.receive(data);
    });

    // Ready when the worker signals on parentPort
    this.ready = new Promise<void>((resolveReady, reject) => {
      const onMessage = (data: unknown) => {
        if (data && typeof data === "object" && (data as any).__type__ === "ready") {
          this._worker.off("message", onMessage);
          this._worker.off("error", onError);
          resolveReady();
        }
      };
      const onError = (err: Error) => {
        this._worker.off("message", onMessage);
        reject(err);
      };
      this._worker.on("message", onMessage);
      this._worker.on("error", onError);
    });
  }

  // --- MessagePort API delegates to channel ---

  get onmessage(): MessageListener | null {
    return this.channel.onmessage;
  }
  set onmessage(fn: MessageListener | null) {
    this.channel.onmessage = fn;
  }
  addEventListener(type: "message", fn: MessageListener): void {
    this.channel.addEventListener(type, fn);
  }
  removeEventListener(type: "message", fn: MessageListener): void {
    this.channel.removeEventListener(type, fn);
  }
  start(): void {
    this.channel.start();
  }
  postMessage(data: unknown): void {
    this.channel.postMessage(data);
  }
  close(): void {
    this.channel.close();
    this._nodePort.close();
  }

  async evaluate<R>(
    fnOrCode: ((...args: any[]) => R | Promise<R>) | string,
    ...args: any[]
  ): Promise<any> {
    const id = `eval-${++this._evalId}`;
    const code = typeof fnOrCode === "function" ? fnOrCode.toString() : fnOrCode;

    return new Promise<unknown>((resolveEval, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        this._worker.off("message", handler);
        this._worker.off("error", onError);
      };
      const handler = (data: unknown) => {
        if (
          data &&
          typeof data === "object" &&
          (data as any).__type__ === "evalResult" &&
          (data as any).__id__ === id
        ) {
          cleanup();
          if ((data as any).error) reject(new Error((data as any).error));
          else resolveEval((data as any).result);
        }
      };
      const onError = (err: Error) => {
        if (settled) return;
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`evaluate() timed out after 10000ms (id: ${id})`));
      }, 10_000);

      this._worker.on("message", handler);
      this._worker.on("error", onError);
      this._worker.postMessage({ __type__: "eval", code, args, __id__: id });
    });
  }

  async _terminate(): Promise<void> {
    this.close();
    await this._worker.terminate();
  }
}

import type { MessageListener, TestHarnessEnv } from "../types.ts";
import { PortChannel } from "./port-channel.ts";

/**
 * A TestHarnessEnv that runs in the current test process.
 *
 * Used when no host configuration is provided — the test process itself
 * acts as the host. `evaluate()` runs functions directly in-process.
 * The MessagePort-shaped channel delegates to a composed PortChannel.
 */
export class TestProcessEnv implements TestHarnessEnv {
  readonly ready: Promise<void> = Promise.resolve();
  readonly channel: PortChannel;

  constructor(deliver?: (data: unknown) => void) {
    this.channel = new PortChannel(deliver);
  }

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
  }

  async evaluate<R>(
    fnOrCode: ((...args: any[]) => R | Promise<R>) | string,
    ...args: any[]
  ): Promise<any> {
    if (typeof fnOrCode === "string") {
      return new Function(fnOrCode)();
    }
    return fnOrCode(...args);
  }
}

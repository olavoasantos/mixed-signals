import type { MessageEventLike, MessageListener } from "../types.ts";

/**
 * A reusable MessagePort-shaped channel with queue-until-start semantics.
 *
 * Extracts the duplicated state machine (queue, start, dispatch, close,
 * onmessage auto-start) that was previously copy-pasted across every env
 * class. Each env composes a PortChannel and delegates the MessagePort API
 * to it.
 *
 * The channel has two sides:
 * - **Inbound:** `receive(data)` enqueues or dispatches a message from the
 *   remote side. Consumers register via `onmessage` / `addEventListener`.
 * - **Outbound:** `postMessage(data)` invokes the `deliver` callback that
 *   was injected at construction (or set later via `setDeliver`).
 */
export class PortChannel {
  private _onmessage: MessageListener | null = null;
  private _listeners = new Set<MessageListener>();
  private _started = false;
  private _closed = false;
  private _queue: unknown[] = [];
  private _deliver: ((data: unknown) => void) | null;
  private _onReceive: ((data: unknown) => void) | null = null;

  constructor(deliver?: (data: unknown) => void) {
    this._deliver = deliver ?? null;
  }

  get onmessage(): MessageListener | null {
    return this._onmessage;
  }

  set onmessage(fn: MessageListener | null) {
    this._onmessage = fn;
    if (fn) this.start();
  }

  /** Callback fired whenever receive() is called (before queue/dispatch). */
  get onReceive(): ((data: unknown) => void) | null {
    return this._onReceive;
  }

  set onReceive(fn: ((data: unknown) => void) | null) {
    this._onReceive = fn;
  }

  addEventListener(type: "message", fn: MessageListener): void {
    if (type === "message") this._listeners.add(fn);
  }

  removeEventListener(type: "message", fn: MessageListener): void {
    this._listeners.delete(fn);
  }

  /** Begin dispatching queued messages. */
  start(): void {
    if (this._started || this._closed) return;
    this._started = true;
    while (this._queue.length) {
      this._dispatch(this._queue.shift());
    }
  }

  /** Send a message to the remote side via the deliver callback. */
  postMessage(data: unknown): void {
    if (this._closed) return;
    this._deliver?.(data);
  }

  /** Close the channel. Drops the queue and all listeners. */
  close(): void {
    this._closed = true;
    this._started = false;
    this._queue.length = 0;
    this._listeners.clear();
    this._onmessage = null;
    this._onReceive = null;
  }

  /**
   * Receive a message from the remote side. Queues if not started,
   * dispatches immediately otherwise.
   */
  receive(data: unknown): void {
    if (this._closed) return;
    this._onReceive?.(data);
    if (!this._started) {
      this._queue.push(data);
      return;
    }
    this._dispatch(data);
  }

  /** Replace the outbound delivery callback. */
  setDeliver(deliver: (data: unknown) => void): void {
    this._deliver = deliver;
  }

  get closed(): boolean {
    return this._closed;
  }

  private _dispatch(data: unknown): void {
    const ev: MessageEventLike = { data };
    this._onmessage?.(ev);
    this._listeners.forEach((l) => l(ev));
  }
}

/**
 * Create a linked pair of PortChannels where A.postMessage delivers to
 * B.receive and vice versa. Useful for in-process testing or wiring
 * TestProcessEnv ↔ NodeWorkerEnv.
 */
export function createPortChannelPair(): [PortChannel, PortChannel] {
  const a = new PortChannel();
  const b = new PortChannel();
  a.setDeliver((data) => b.receive(data));
  b.setDeliver((data) => a.receive(data));
  return [a, b];
}

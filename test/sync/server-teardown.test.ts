/**
 * Tests for the server-side teardown features:
 *
 *   - M003I007T: Epoch tracking through handshake
 *   - M003I006T: Host client_dead handler + onClientDead callback
 *   - M003I005T: Host-side CALLER_STATE poll
 *
 * Uses the same stub-transport testing approach as enable-server.test.ts.
 */
import {describe, expect, it, vi} from 'vitest';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {
  CALLER_STATE,
  CHUNK_STATE,
  CONTROL_SAB_BYTES,
  CTRL,
  allocateLane,
  loadCtrl,
  storeCtrl,
} from '../../sync/lane.ts';
import {enableSyncServer} from '../../sync/server.ts';

// ── Helpers ────────────────────────────────────────────────────────────

type Listener = (data: unknown, ctx?: TransportContext) => void | Promise<void>;

function createStubTransport() {
  const sent: unknown[] = [];
  let listener: Listener | undefined;
  const transport: RawTransport = {
    mode: 'raw',
    send(data) {
      sent.push(data);
    },
    onMessage(cb) {
      listener = cb;
    },
  };
  return {
    transport,
    sent,
    /** Simulate inbound message from the caller side */
    receive(data: unknown) {
      listener?.(data);
    },
  };
}

function extractHsRes(sent: unknown[]): {
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
  epoch: number;
} {
  const hs = sent.find(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      (m as {__sync?: string}).__sync === 'hs-res',
  ) as {control: SharedArrayBuffer; data: SharedArrayBuffer; epoch: number};
  if (!hs) throw new Error('No hs-res found in sent messages');
  return hs;
}

// ── M003I007T: Epoch tracking ──────────────────────────────────────────

describe('epoch tracking through handshake', () => {
  it('includes epoch in hs-res response', () => {
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport);

    receive({__sync: 'hs-req'});

    const hs = extractHsRes(sent);
    expect(hs.epoch).toBeTypeOf('number');
    expect(hs.epoch).toBeGreaterThan(0);
  });

  it('increments epoch on each handshake (monotonic)', () => {
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport);

    receive({__sync: 'hs-req'});
    const hs1 = extractHsRes(sent);
    sent.length = 0;

    receive({__sync: 'hs-req'});
    const hs2 = extractHsRes(sent);

    expect(hs2.epoch).toBeGreaterThan(hs1.epoch);
  });

  it('rejects client_dead with stale epoch (HMR safety)', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport, {onClientDead});

    // First handshake.
    receive({__sync: 'hs-req'});
    const hs1 = extractHsRes(sent);
    sent.length = 0;

    // Second handshake (simulates HMR recycle).
    receive({__sync: 'hs-req'});
    const hs2 = extractHsRes(sent);

    // Stale notification from old bridge (epoch 1).
    receive({__sync: 'client_dead', epoch: hs1.epoch, clientId: 'old-worker'});
    expect(onClientDead).not.toHaveBeenCalled();

    // Current notification with correct epoch.
    receive({
      __sync: 'client_dead',
      epoch: hs2.epoch,
      clientId: 'new-worker',
    });
    expect(onClientDead).toHaveBeenCalledWith('new-worker');
  });

  it('rejects client_dead with epoch 0 (pre-handshake death)', () => {
    const onClientDead = vi.fn();
    const {transport, receive} = createStubTransport();
    enableSyncServer(transport, {onClientDead});

    receive({__sync: 'client_dead', epoch: 0, clientId: 'c1'});
    expect(onClientDead).not.toHaveBeenCalled();
  });
});

// ── M003I006T: Host client_dead handler ────────────────────────────────

describe('host client_dead handler + onClientDead callback', () => {
  it('invokes onClientDead with the clientId from the notification', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);

    receive({
      __sync: 'client_dead',
      epoch: hs.epoch,
      clientId: 'worker-42',
    });
    expect(onClientDead).toHaveBeenCalledOnce();
    expect(onClientDead).toHaveBeenCalledWith('worker-42');
  });

  it('deduplicates: second client_dead for same clientId is a no-op', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);

    receive({
      __sync: 'client_dead',
      epoch: hs.epoch,
      clientId: 'worker-42',
    });
    receive({
      __sync: 'client_dead',
      epoch: hs.epoch,
      clientId: 'worker-42',
    });
    expect(onClientDead).toHaveBeenCalledOnce();
  });

  it('drops client_dead with malformed clientId', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);

    // undefined clientId
    receive({__sync: 'client_dead', epoch: hs.epoch, clientId: ''});
    // null clientId
    receive({
      __sync: 'client_dead',
      epoch: hs.epoch,
      clientId: null as unknown as string,
    });
    expect(onClientDead).not.toHaveBeenCalled();
  });

  it('catches and swallows user callback throws', () => {
    const onClientDead = vi.fn(() => {
      throw new Error('user callback exploded');
    });
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);

    // Should not throw.
    expect(() =>
      receive({
        __sync: 'client_dead',
        epoch: hs.epoch,
        clientId: 'w1',
      }),
    ).not.toThrow();
    expect(onClientDead).toHaveBeenCalled();
  });

  it('works without onClientDead callback (no-op)', () => {
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport);

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);

    // Should not throw even without a callback.
    expect(() =>
      receive({
        __sync: 'client_dead',
        epoch: hs.epoch,
        clientId: 'w1',
      }),
    ).not.toThrow();
  });
});

// ── M003I005T: Host-side CALLER_STATE poll ─────────────────────────────

describe('host-side CALLER_STATE poll', () => {
  it('aborts response chunk write when CALLER_STATE is DEAD', async () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    let rpcCallback: Listener | undefined;

    const wrapper = enableSyncServer(transport, {
      onClientDead,
      clientId: 'test-worker',
    });

    // Wire up the "RPC" callback to capture and respond immediately.
    wrapper.onMessage((data) => {
      rpcCallback?.(data);
    });

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);
    const controlView = new Int32Array(hs.control);
    const dataU8 = new Uint8Array(hs.data);

    // Set up a callback that immediately responds (simulating RPC dispatch).
    rpcCallback = (msg) => {
      const m = msg as WireMessage;
      if (m.type === 'call') {
        // Before the response can be written, mark caller dead.
        Atomics.store(controlView, CTRL.CALLER_STATE, CALLER_STATE.DEAD);
        // Send the response through the wrapper's send path.
        wrapper.send({type: 'result', id: m.id, value: 'too late'});
      }
    };

    // Write a minimal request to the data SAB.
    const request = JSON.stringify({
      seq: 1,
      calls: [{method: 'test', params: []}],
    });
    const encoded = new TextEncoder().encode(request);
    dataU8.set(encoded, 0);
    storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, encoded.byteLength);
    storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.DONE);
    storeCtrl(controlView, CTRL.BATCH_SIZE, 1);
    storeCtrl(controlView, CTRL.REQUEST_SEQ, 1);

    // Doorbell triggers the dispatch.
    await receive({__sync: 'doorbell', seq: 1});

    // The response chunk should NOT have been written because
    // CALLER_STATE was DEAD. The onClientDead callback should fire.
    expect(onClientDead).toHaveBeenCalledWith('test-worker');
  });

  it('does not fire onClientDead from poll without configured clientId', async () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();

    const wrapper = enableSyncServer(transport, {onClientDead});
    // No clientId configured.

    wrapper.onMessage((data) => {
      const m = data as WireMessage;
      if (m.type === 'call') {
        wrapper.send({type: 'result', id: m.id, value: 'ok'});
      }
    });

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);
    const controlView = new Int32Array(hs.control);
    const dataU8 = new Uint8Array(hs.data);

    // Mark caller dead before the response write.
    const request = JSON.stringify({
      seq: 1,
      calls: [{method: 'test', params: []}],
    });
    const encoded = new TextEncoder().encode(request);
    dataU8.set(encoded, 0);
    storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, encoded.byteLength);
    storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.DONE);
    storeCtrl(controlView, CTRL.BATCH_SIZE, 1);
    storeCtrl(controlView, CTRL.REQUEST_SEQ, 1);

    // Set DEAD before doorbell so the poll fires during response write.
    Atomics.store(controlView, CTRL.CALLER_STATE, CALLER_STATE.DEAD);

    await receive({__sync: 'doorbell', seq: 1});

    // Without a configured clientId, the poll path should silently
    // drop rather than calling onClientDead with an empty string.
    expect(onClientDead).not.toHaveBeenCalled();
  });
});

// ── Lifecycle reset regression tests ───────────────────────────────

describe('lifecycle reset on re-handshake', () => {
  it('clears CALLER_STATE on re-handshake so doorbells work again', async () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    let rpcCallback: ((data: unknown) => void) | undefined;

    const wrapper = enableSyncServer(transport, {
      onClientDead,
      clientId: 'reset-test',
    });
    wrapper.onMessage((data) => {
      rpcCallback?.(data);
    });

    // First handshake.
    receive({__sync: 'hs-req'});
    const hs1 = extractHsRes(sent);
    const controlView = new Int32Array(hs1.control);
    const dataU8 = new Uint8Array(hs1.data);

    // Simulate death via client_dead notification.
    receive({
      __sync: 'client_dead',
      epoch: hs1.epoch,
      clientId: 'reset-test',
    });
    expect(onClientDead).toHaveBeenCalledOnce();

    // Re-handshake (HMR recycle).
    sent.length = 0;
    onClientDead.mockClear();
    receive({__sync: 'hs-req'});
    const hs2 = extractHsRes(sent);

    // CALLER_STATE should now be ALIVE, not stuck at DEAD.
    expect(Atomics.load(controlView, CTRL.CALLER_STATE)).toBe(
      CALLER_STATE.ALIVE,
    );

    // A doorbell should be accepted (not silently dropped).
    let doorbellProcessed = false;
    rpcCallback = (msg) => {
      doorbellProcessed = true;
      const m = msg as WireMessage;
      if (m.type === 'call') {
        wrapper.send({type: 'result', id: m.id, value: 'alive'});
      }
    };

    const request = JSON.stringify({
      seq: 1,
      calls: [{method: 'ping', params: []}],
    });
    const encoded = new TextEncoder().encode(request);
    dataU8.set(encoded, 0);
    storeCtrl(controlView, CTRL.CHUNK_BYTES_VALID, encoded.byteLength);
    storeCtrl(controlView, CTRL.CHUNK_STATE, CHUNK_STATE.DONE);
    storeCtrl(controlView, CTRL.BATCH_SIZE, 1);
    storeCtrl(controlView, CTRL.REQUEST_SEQ, 1);

    await receive({__sync: 'doorbell', seq: 1});
    expect(doorbellProcessed).toBe(true);
  });

  it('allows same clientId to die again in a new epoch', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    enableSyncServer(transport, {onClientDead});

    // First handshake + death.
    receive({__sync: 'hs-req'});
    const hs1 = extractHsRes(sent);
    receive({
      __sync: 'client_dead',
      epoch: hs1.epoch,
      clientId: 'same-id',
    });
    expect(onClientDead).toHaveBeenCalledTimes(1);

    // Re-handshake with same clientId.
    sent.length = 0;
    receive({__sync: 'hs-req'});
    const hs2 = extractHsRes(sent);

    // Second death with same clientId but new epoch.
    receive({
      __sync: 'client_dead',
      epoch: hs2.epoch,
      clientId: 'same-id',
    });
    expect(onClientDead).toHaveBeenCalledTimes(2);
  });
});

// ── markDead unit tests ────────────────────────────────────────────

describe('enableSyncServer markDead', () => {
  it('fires onClientDead with the given clientId', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    const wrapper = enableSyncServer(transport, {
      onClientDead,
      clientId: 'mark-dead-test',
    });

    receive({__sync: 'hs-req'});

    wrapper.markDead('mark-dead-test');
    expect(onClientDead).toHaveBeenCalledWith('mark-dead-test');
  });

  it('stores CALLER_STATE.DEAD in the SAB', () => {
    const {transport, sent, receive} = createStubTransport();
    const wrapper = enableSyncServer(transport);

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);
    const controlView = new Int32Array(hs.control);

    wrapper.markDead('w1');
    expect(Atomics.load(controlView, CTRL.CALLER_STATE)).toBe(
      CALLER_STATE.DEAD,
    );
  });

  it('is idempotent — second call is a no-op', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    const wrapper = enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});

    wrapper.markDead('w1');
    wrapper.markDead('w1');
    expect(onClientDead).toHaveBeenCalledOnce();
  });

  it('ignores empty clientId', () => {
    const onClientDead = vi.fn();
    const {transport, receive} = createStubTransport();
    const wrapper = enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});

    wrapper.markDead('');
    expect(onClientDead).not.toHaveBeenCalled();
  });

  it('deduplicates with the postMessage client_dead path', () => {
    const onClientDead = vi.fn();
    const {transport, sent, receive} = createStubTransport();
    const wrapper = enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});
    const hs = extractHsRes(sent);

    // markDead fires first.
    wrapper.markDead('w1');
    expect(onClientDead).toHaveBeenCalledOnce();

    // Then the postMessage notification arrives — should be deduped.
    receive({
      __sync: 'client_dead',
      epoch: hs.epoch,
      clientId: 'w1',
    });
    expect(onClientDead).toHaveBeenCalledOnce();
  });

  it('swallows onClientDead callback errors', () => {
    const onClientDead = vi.fn(() => {
      throw new Error('callback threw');
    });
    const {transport, receive} = createStubTransport();
    const wrapper = enableSyncServer(transport, {onClientDead});

    receive({__sync: 'hs-req'});

    expect(() => wrapper.markDead('w1')).not.toThrow();
    expect(onClientDead).toHaveBeenCalled();
  });
});

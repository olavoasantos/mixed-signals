/**
 * Cross-origin iframe-broker sync RPC — **tunneled MessagePort variant**.
 *
 * The broker's upstream transport to the parent is a `MessagePort`
 * that was tunneled through the worker at handshake, rather than
 * `window.parent.postMessage`. The mechanism is exercised in isolation
 * in `tunneled-port-spike.test.ts`; this file is the full sync-RPC
 * integration through that transport.
 *
 * Mirrors `iframe-proxy.test.ts`'s test surface so the two variants
 * read as a direct A/B comparison: same expectations, different
 * transport plumbing.
 *
 * If these all pass, the broker is transport-agnostic over its
 * upstream channel — callers can integrate it with any
 * MessagePort-based async transport without changing how the host
 * wires up handlers.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Browser, BrowserContext} from 'playwright';
import {SyncRpcTunneledBrokerClient} from './browser-harness/SyncRpcTunneledBrokerClient.ts';

describe('sync RPC tunneled-port broker (cross-origin parent ↔ broker iframe ↔ worker)', () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    const {chromium} = await import('playwright');
    browser = await chromium.launch();
    context = await browser.newContext({ignoreHTTPSErrors: true});
  }, 30_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  it('rpc.wait round-trips a primitive across the tunneled-port broker', async () => {
    const h = await SyncRpcTunneledBrokerClient.create(context);
    await h.expose({add: (a: number, b: number) => a + b});

    const sum = await h.workerEvaluate(
      (client) => client.wait([client.root.add(3, 4)])[0],
    );
    expect(sum).toBe(7);

    await h.page.close();
  }, 30_000);

  it('rpc.wait round-trips an N-arity batch across the tunneled-port broker', async () => {
    const h = await SyncRpcTunneledBrokerClient.create(context);
    await h.expose({
      add: (a: number, b: number) => a + b,
      greet: (name: string) => `hi ${name}`,
      answer: () => 42,
    });

    const results = await h.workerEvaluate((client) =>
      client.wait([
        client.root.add(3, 4),
        client.root.greet('world'),
        client.root.answer(),
      ]),
    );
    expect(results).toEqual([7, 'hi world', 42]);

    await h.page.close();
  }, 30_000);

  it('rpc.wait round-trips multi-chunk both directions across the tunneled-port broker', async () => {
    const h = await SyncRpcTunneledBrokerClient.create(context, {
      dataSabSize: 1024,
    });
    await h.expose({echo: (s: string) => s});

    const payload = 't'.repeat(5000);
    const result = await h.workerEvaluate(
      (client, arg) => client.wait([client.root.echo(arg)])[0] as string,
      payload,
    );
    expect(result).toBe(payload);

    await h.page.close();
  }, 30_000);
});

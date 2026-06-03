import {describe, expect, it} from 'vitest';
import * as syncNode from '../../sync/index.node.ts';
import * as syncBrowser from '../../sync/index.ts';

/**
 * The Node-conditional entry (`./sync` with the `node` condition)
 * must expose the same public surface as the browser-default entry.
 * Only `supportsSync` may differ in implementation; the rest comes
 * from shared modules. Drift between the two surfaces would split
 * the package's public API based on which runtime the consumer is
 * on — a subtle and easy-to-miss bug.
 */
describe('mixed-signals/sync — Node entry parity with browser entry', () => {
  // Node-only exports that legitimately differ from the browser surface.
  const NODE_ONLY_EXPORTS = new Set(['createNodeWorkerBridge']);

  it('exposes every browser export key (superset check)', () => {
    const browserKeys = Object.keys(syncBrowser).sort();
    const nodeKeys = Object.keys(syncNode).sort();
    // Every browser key must also appear in the Node entry.
    for (const key of browserKeys) {
      expect(nodeKeys).toContain(key);
    }
    // Any extra Node keys must be in the allowlist.
    const extras = nodeKeys.filter((k) => !browserKeys.includes(k));
    for (const key of extras) {
      expect(NODE_ONLY_EXPORTS.has(key)).toBe(true);
    }
  });

  it('shares the error-class identities across entries', () => {
    // Every error class is sourced from `./errors.ts`, so the two
    // entries must reference the same constructor objects. If they
    // diverge, `instanceof` checks across runtime boundaries break.
    for (const name of Object.keys(syncBrowser)) {
      if (!name.startsWith('SyncRPC')) continue;
      const a = (syncBrowser as unknown as Record<string, unknown>)[name];
      const b = (syncNode as unknown as Record<string, unknown>)[name];
      expect(b).toBe(a);
    }
  });

  it('shares non-error wrappers across entries', () => {
    for (const name of [
      'enableSyncServer',
      'enableSyncClient',
      'createIframeRelayBridge',
      'createIframeBrokerBridge',
      'wrapWindowPostMessage',
      'wrapMessagePort',
    ]) {
      const a = (syncBrowser as unknown as Record<string, unknown>)[name];
      const b = (syncNode as unknown as Record<string, unknown>)[name];
      expect(b).toBe(a);
    }
  });

  it('uses a different supportsSync implementation than the browser entry', () => {
    expect(syncNode.supportsSync).not.toBe(syncBrowser.supportsSync);
  });
});

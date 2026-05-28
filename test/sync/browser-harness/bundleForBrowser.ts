/**
 * Bundles a TypeScript entry into a self-contained browser-runnable
 * IIFE string. Used by `sync-worker.spec.ts` to inject test entries
 * into Playwright pages and workers without a separate build step.
 *
 * Uses the project's existing bundler (tsdown / rolldown) so we don't
 * pull in Vite just for the test harness.
 */
import {Rolldown} from 'tsdown';

export async function bundleForBrowser(entry: string): Promise<string> {
  const bundle = await Rolldown.rolldown({
    input: entry,
    platform: 'browser',
  });
  const {output} = await bundle.generate({
    format: 'iife',
    name: '__bundle__',
  });
  await bundle.close();
  const first = output[0];
  if (!first || first.type !== 'chunk') {
    throw new Error('bundleForBrowser: expected an IIFE chunk');
  }
  return first.code;
}

import {defineConfig} from 'vitest/config';

/**
 * Vitest config for browser harness tests only. These tests require
 * Playwright browsers to be installed:
 *
 *   npx playwright install chromium
 *   pnpm vitest run --config vitest.browser-harness.config.ts
 */
export default defineConfig({
  test: {
    include: ['test/harness/browser-*.test.ts'],
    fileParallelism: false,
  },
});

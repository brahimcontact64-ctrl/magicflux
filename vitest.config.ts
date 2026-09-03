import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    // Phase 9.5 — e2e/**/*.spec.ts are Playwright specs (run via
    // `npx playwright test`), not vitest tests; without this exclude,
    // vitest's default include pattern picks them up too and they fail to
    // import '@playwright/test' outside its own runner.
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // 'server-only' is a Next.js guard package with no runtime export.
      // Map it to an empty shim so server-side modules can be imported in tests.
      'server-only': path.resolve(__dirname, '__mocks__/server-only.ts'),
    },
  },
});

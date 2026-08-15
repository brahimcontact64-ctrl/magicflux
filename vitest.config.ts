import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
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

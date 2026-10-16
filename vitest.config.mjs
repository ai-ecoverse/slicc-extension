import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@slicc/shared-ts': at('six/shared-ts/index.ts'),
      '@ai-ecoverse/cherry/embed-ui': at('six/cherry/embed-ui.ts'),
    },
  },
  define: { __SLICC_EXT_DEV__: 'false' },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/six/**/*.test.ts'],
    passWithNoTests: true,
    retry: 2,
  },
});

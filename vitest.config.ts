import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const contract = (f: string): string => fileURLToPath(new URL(`./packages/contract/src/${f}`, import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      // Tests run against sources, so they do not need a prior build.
      { find: '@devhost/contract/lite', replacement: contract('lite.ts') },
      { find: '@devhost/contract', replacement: contract('index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 20000,
    // Plugins in a test home are loaded with Node's own import(), as in the CLI; jsdom tests would
    // otherwise send them through Vite's transform, which cannot read a temporary directory.
    server: { deps: { external: [/\/\.config\/devhost\/plugins\//] } },
  },
});

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and a relative base so the bundled app loads from tauri://.
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  resolve: {
    // The browser-safe contract entry (types + schemas, no validator), straight from source.
    alias: { '@devhost/contract/lite': fileURLToPath(new URL('../contract/src/lite.ts', import.meta.url)) },
  },
  build: { target: 'safari17', outDir: 'dist', emptyOutDir: true },
});

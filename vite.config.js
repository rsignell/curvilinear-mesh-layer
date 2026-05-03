import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
  ],
  optimizeDeps: {
    // Prevent Vite from pre-bundling WASM packages — they need to be loaded as-is
    exclude: ['@earthmover/icechunk'],
  },
  build: {
    target: 'esnext',
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer (used by some WASM builds)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});

import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  base: '/curvilinear-mesh-layer/',
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ['@earthmover/icechunk', '@earthmover/icechunk-wasm32-wasi'],
    include: ['@earthmover/icechunk > @earthmover/icechunk-wasm32-wasi'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
  },
});

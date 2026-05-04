import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  base: '/curvilinear-mesh-layer/',
  plugins: [wasm()],
  optimizeDeps: {
    exclude: ['@earthmover/icechunk'],
  },
  build: {
    target: 'esnext',
  },
});

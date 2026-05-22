import { defineConfig } from 'vite';

// Local dev proxies API + LLM endpoints to wrangler dev (http://127.0.0.1:8787)
// so cookies look same-origin. In prod the game hits api.personalspace.fun
// directly via the same path prefixes.
const WORKER = 'http://127.0.0.1:8787';

export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api':   { target: WORKER, changeOrigin: true },
      '/tier1': { target: WORKER, changeOrigin: true },
      '/tier2': { target: WORKER, changeOrigin: true },
      '/tier3': { target: WORKER, changeOrigin: true },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  build: { target: 'es2022' }
});

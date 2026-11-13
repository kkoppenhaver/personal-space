import { defineConfig, devices } from '@playwright/test';

// Browser smoke test + seed gallery. Runs against the PRODUCTION bundle
// (vite build → vite preview) in offline mode: VITE_WORKER_URL is blanked
// for this build so the client never talks to a worker and every LLM tier
// falls back to the deterministic placeholder generators. tests/e2e/guard.js
// additionally aborts any request to the prod API or a model provider.
//
// Port 5187 on purpose: 5173/5174 (vite dev) and 8787 (wrangler) are
// usually taken on dev machines.
const PORT = Number(process.env.E2E_PORT) || 5187;

export default defineConfig({
  testDir: 'tests/e2e',
  // Software rendering (SwiftShader) is slow and the game streams 45 planets.
  timeout: 240_000,
  expect: { timeout: 90_000 },
  // One browser at a time: two SwiftShader pages fight for CPU and the
  // gallery wants stable timing.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // WebGL2 without a GPU (CI runners have none). Verified on headless
      // Chromium 158: these three give an ANGLE → Vulkan → SwiftShader
      // context. Also used locally so a Mac renders through the same
      // software rasterizer as CI (no Metal-vs-SwiftShader drift).
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    env: { VITE_WORKER_URL: '' },   // offline build: never bake in the prod worker
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

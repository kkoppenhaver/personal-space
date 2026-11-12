import { defineConfig } from 'vitest/config';

// Unit tests only. Browser tests live in tests/e2e and run under Playwright
// (playwright.config.js), never under vitest.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
  },
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  baseURL: 'http://localhost:3000',
  retries: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    // Navigation timeout generous — the app loads iframes to external services
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});

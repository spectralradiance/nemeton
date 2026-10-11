import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against a production build, because the service worker is disabled in dev.
// Locally they use the installed Microsoft Edge (no browser download); CI installs Chromium.

const PORT = 5399;
const channel = process.env.CI ? undefined : 'msedge';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
    { name: 'phone', use: { ...devices['Pixel 7'], channel } },
  ],
  webServer: [
    {
      command: 'npm run start:server',
      url: 'http://localhost:8787/api/health',
      reuseExistingServer: true,
    },
    {
      command: `npm run build -w @nemeton/web && npm run preview -w @nemeton/web -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

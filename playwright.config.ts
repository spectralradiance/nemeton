import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_DB, E2E_DIR } from './e2e/paths';

// End-to-end tests run against a production build, because the service worker is disabled in dev.
// They get their own API server and a throwaway database, so they never touch dev data.
// Locally they use the installed Microsoft Edge (no browser download); CI installs Chromium.

const WEB_PORT = 5399;
const API_PORT = 8799;
mkdirSync(E2E_DIR, { recursive: true });
// Best-effort cleanup of earlier runs' databases (one may still be locked; that's fine).
for (const file of readdirSync(E2E_DIR)) {
  if (!file.startsWith(`run-${process.env.NEMETON_E2E_RUN}`)) {
    try {
      rmSync(join(E2E_DIR, file));
    } catch {
      // in use
    }
  }
}

const channel = process.env.CI ? undefined : 'msedge';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
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
      env: { API_PORT: String(API_PORT), NEMETON_DB: E2E_DB },
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `npm run build -w @nemeton/web && npm run preview -w @nemeton/web -- --port ${WEB_PORT} --strictPort`,
      env: { API_URL: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

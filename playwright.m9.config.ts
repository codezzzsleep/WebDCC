import { defineConfig } from '@playwright/test';

const PORT = 8791;
const TOKEN = 'e2e-token-0123456789abcdef0123456789';
const jsonOutput = process.env['M9_PLAYWRIGHT_JSON'] ?? '/tmp/wdcc-m9-replay-results.json';

export default defineConfig({
  testDir: './e2e-m9',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['json', { outputFile: jsonOutput }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `WDCC_TOKEN=${TOKEN} WDCC_PORT=${PORT} WDCC_HOST=127.0.0.1 WDCC_IDLE_DISPOSE_MIN=0 pnpm tsx scripts/e2e-replay-server.ts`,
    url: `http://127.0.0.1:${PORT}/api/meta`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});

export const E2E_M9_TOKEN = TOKEN;

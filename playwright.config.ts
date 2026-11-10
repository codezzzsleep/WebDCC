import { defineConfig } from '@playwright/test';

const PORT = 8790;
const TOKEN = 'e2e-token-0123456789abcdef0123456789';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `rm -rf /tmp/wdcc-e2e && WDCC_TOKEN=${TOKEN} WDCC_PORT=${PORT} WDCC_HOST=127.0.0.1 WDCC_DATA_DIR=/tmp/wdcc-e2e WDCC_IDLE_DISPOSE_MIN=0 npx tsx scripts/e2e-server.ts`,
    url: `http://127.0.0.1:${PORT}/api/meta`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});

export const E2E_TOKEN = TOKEN;

import { defineConfig } from '@playwright/test';

// e2e 在 M2 起逐步落地；第 15 节 A6 的断网/限速场景用这里的网络模拟跑。
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.WDCC_E2E_BASE_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});

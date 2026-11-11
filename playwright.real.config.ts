import { defineConfig } from '@playwright/test';

/** M8 真实界面验收（SPEC-M8 6.1）：真实 Agent + 假模型，禁用 FakeAdapter */
export default defineConfig({
  testDir: './e2e-real',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['./e2e-real/reporter.ts']],
  globalSetup: './e2e-real/globalSetup.ts',
  globalTeardown: './e2e-real/globalTeardown.ts',
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});

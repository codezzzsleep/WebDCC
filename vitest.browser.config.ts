import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  environment: 'node',
  include: ['browser-tests/**/*.spec.ts'],
  testTimeout: 30_000,
  hookTimeout: 30_000,
  pool: 'forks',
  maxWorkers: 1,
  minWorkers: 1,
  // These tests wait for real HTTP/WebSocket and Chromium rendering.
  expect: { poll: { timeout: 10_000 } },
} });

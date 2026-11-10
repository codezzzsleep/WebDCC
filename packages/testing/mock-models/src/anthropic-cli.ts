/**
 * 独立启动 mock-anthropic：
 *   node --experimental-strip-types src/anthropic-cli.ts --plan plans/probe.json --port 4010
 * 或 pnpm mock:anthropic -- --plan plans/probe.json --port 4010
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAnthropicMock } from './anthropic-server.js';
import { isPlan, type Plan } from './plan.js';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

export function loadPlanFromFile(path: string): Plan {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlan(parsed)) throw new Error(`${path} 不是合法的 plan 数组`);
  return parsed;
}

async function main(): Promise<void> {
  const planPath = resolve(arg('plan', 'packages/testing/mock-models/plans/probe.json') ?? 'packages/testing/mock-models/plans/probe.json');
  const port = Number(arg('port', process.env['WDCC_MOCK_PORT'] ?? '4010'));
  const plan = loadPlanFromFile(planPath);
  const mock = await startAnthropicMock({
    plan,
    port,
    recordPath: process.env['WDCC_MOCK_RECORD'],
  });
  process.stdout.write(`mock-anthropic listening on ${mock.url} (plan: ${planPath}, ${plan.length} steps)\n`);
  const shutdown = (): void => {
    void mock.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  await main();
}

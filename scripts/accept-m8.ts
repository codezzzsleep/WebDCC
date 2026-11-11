/**
 * M8 验收入口（SPEC-M8 6.1）。
 *   pnpm accept:m8            严格模式：全部步骤 + 真实套件连续两遍
 *   pnpm accept:m8 --ratchet  开发期：只要求"之前通过过的用例不能变红"
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ratchet = process.argv.includes('--ratchet');

function run(command: string, args: string[], label: string): void {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    execFileSync(command, args, { stdio: 'inherit' });
  } catch {
    process.stderr.write(`\n[${label}] 失败\n`);
    process.exit(1);
  }
}

run('pnpm', ['typecheck'], 'typecheck');
run('pnpm', ['lint'], 'lint');
run('npx', ['vitest', 'run'], 'unit tests');
run('npx', ['playwright', 'test', 'e2e/', '--reporter=list'], 'fake-adapter e2e');
run('pnpm', ['build'], 'build');

const passes = ratchet ? 1 : 2;
for (let pass = 1; pass <= passes; pass += 1) {
  run('npx', ['playwright', 'test', '-c', 'playwright.real.config.ts'], `real acceptance pass ${pass}/${passes}`);
}

if (ratchet) {
  const statusPath = 'docs/acceptance/M8/status.json';
  if (!existsSync(statusPath)) {
    process.stderr.write('缺少 docs/acceptance/M8/status.json\n');
    process.exit(1);
  }
  const current = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, boolean>;
  let baseline: Record<string, boolean> = {};
  try {
    baseline = JSON.parse(execFileSync('git', ['show', 'origin/main:docs/acceptance/M8/status.json'], { encoding: 'utf8' })) as Record<string, boolean>;
  } catch {
    baseline = {};
  }
  const regressions = Object.entries(baseline)
    .filter(([id, passed]) => passed && current[id] !== true)
    .map(([id]) => id);
  if (regressions.length > 0) {
    process.stderr.write(`棘轮失败：之前通过的用例变红了：${regressions.join(', ')}\n`);
    process.exit(1);
  }
  const newlyPassed = Object.entries(current).filter(([id, passed]) => passed && baseline[id] !== true).map(([id]) => id);
  process.stdout.write(`\n棘轮通过。本次由失败变通过：${newlyPassed.join(', ') || '无'}\n`);
}

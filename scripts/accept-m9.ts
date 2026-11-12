import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const out = join(process.cwd(), 'docs/acceptance/M9');
mkdirSync(join(out, 'shots'), { recursive: true });
const runId = `${Date.now().toString(36)}-${process.pid}`;
const buildRoot = join(tmpdir(), `wdcc-accept-${runId}`, 'build');
mkdirSync(buildRoot, { recursive: true });

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(command, args, { stdio: 'inherit', env });
}

run('pnpm', ['typecheck']);
run('pnpm', ['lint']);
run('pnpm', ['trace:scan']);
run('pnpm', ['test']);
const l1Raw = execFileSync('pnpm', ['tsx', 'scripts/l1-replay.ts', 'fixtures/traces'], { encoding: 'utf8' });
const l1Result = JSON.parse(l1Raw) as { passed: number; total: number; fixtures: number };
let replayUiPassed = 0;
let replayUiTotal = 0;
const acceptWeb = join(buildRoot, 'web');
const acceptServer = join(buildRoot, 'server', 'main.js');
mkdirSync(acceptWeb, { recursive: true });
try { symlinkSync(join(process.cwd(), 'node_modules'), join(buildRoot, 'node_modules'), 'dir'); } catch { /* existing */ }
try { symlinkSync(join(process.cwd(), 'packages/server/node_modules/better-sqlite3'), join(process.cwd(), 'node_modules/better-sqlite3'), 'dir'); } catch { /* existing */ }
run('pnpm', ['--filter', '@webdcc/web', 'build'], { ...process.env, WDCC_BUILD_DIR: acceptWeb });
run('pnpm', ['tsx', 'scripts/build-server.ts'], { ...process.env, WDCC_SERVER_OUT: acceptServer });
if (!process.argv.includes('--skip-e2e')) {
  // Keep the fast M1/M2 UI suite in the gate, while the dedicated M9 config
  // below runs the trace-backed L2 suite.
  run('pnpm', ['e2e'], { ...process.env, WDCC_WEB_DIST: acceptWeb, WDCC_SERVER_ENTRY: acceptServer });
  const replayJson = join(buildRoot, 'replay-ui.json');
  try {
    run('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.m9.config.ts'], {
      ...process.env,
      WDCC_WEB_DIST: acceptWeb,
      WDCC_SERVER_ENTRY: acceptServer,
      M9_PLAYWRIGHT_JSON: replayJson,
    });
    const report = JSON.parse(readFileSync(replayJson, 'utf8')) as { suites?: unknown[] };
    const counts = { passed: 0, total: 0 };
    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      const node = value as { specs?: unknown[]; tests?: unknown[]; results?: unknown[]; suites?: unknown[] };
      if (Array.isArray(node.specs)) for (const spec of node.specs) visit(spec);
      if (Array.isArray(node.tests)) {
        for (const test of node.tests) {
          const results = (test as { results?: unknown[] }).results;
          if (!Array.isArray(results) || results.length === 0) continue;
          counts.total += 1;
          const last = results.at(-1) as { status?: string } | undefined;
          if (last?.status === 'passed') counts.passed += 1;
        }
      }
      if (Array.isArray(node.suites)) for (const suite of node.suites) visit(suite);
    };
    visit(report);
    replayUiPassed = counts.passed;
    replayUiTotal = counts.total;
  } catch {
    // A missing or failed L2 run must be visible as 0/0 in the report.
    replayUiPassed = 0;
    replayUiTotal = 0;
  }
}

const traceRoot = join(process.cwd(), 'fixtures', 'traces');
function countTraces(path: string): number {
  if (!existsSync(path)) return 0;
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.some((entry) => entry.name === 'native.jsonl')) return 1;
  return entries.filter((entry) => entry.isDirectory()).reduce((sum, entry) => sum + countTraces(join(path, entry.name)), 0);
}
const traces = countTraces(traceRoot);
const l1 = l1Result;
const m8 = (() => {
  try {
    const report = JSON.parse(readFileSync(join(process.cwd(), 'docs/acceptance/M8/report.json'), 'utf8')) as { passedCount?: number; expectedCount?: number };
    return { passed: report.passedCount ?? 0, total: report.expectedCount ?? 0 };
  } catch { return { passed: 0, total: 0 }; }
})();
const report = {
  generatedAt: new Date().toISOString(),
  commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
  traces,
  invariants: { passed: l1.passed, total: l1.total },
  replayUi: { passed: replayUiPassed, total: replayUiTotal },
  m8Ratchet: { passed: m8.passed, total: m8.total },
  buildRoot,
};
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(out, 'dsh-compare.html'), '<!doctype html><meta charset="utf-8"><title>M9 DSH 对照</title><p>DSH S01–S11 原生轨迹与 session/page 参照物已入库；原版 DSH 收起/展开截图待补。</p>\n');
process.stdout.write(`M9 ACCEPTANCE: traces ${traces} · invariants ${report.invariants.passed}/${report.invariants.total} · replay-ui ${report.replayUi.passed}/${report.replayUi.total} · m8-ratchet ${report.m8Ratchet.passed}/${report.m8Ratchet.total} @ ${report.commit}\n`);
// M8 is a ratchet: its total includes not-implemented IDs, so only a missing
// report is a gate failure here. `accept:m8 --ratchet` owns the regression
// comparison for the IDs that were already passing.
if (report.replayUi.total === 0 || report.replayUi.passed !== report.replayUi.total || report.m8Ratchet.total === 0) process.exitCode = 1;

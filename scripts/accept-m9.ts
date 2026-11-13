/** M9 includes a fresh strict M8 run; a historical report cannot satisfy it. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpecIds } from '../e2e-real/reporter.js';
import { createRunIdentity, gateIssues, type GateReport } from './lib/gate-report.js';

const identity = createRunIdentity();
const out = process.env['WDCC_M9_OUT'] ?? join(process.cwd(), 'docs/acceptance/M9');
const m8Out = join(out, `m8-${identity.runId}`);
mkdirSync(out, { recursive: true });
const report: GateReport = { formatVersion: 1, gate: 'M9', identity, expectedIds: ['fresh-m8', 'l1-replay', 'replay-browser'], results: [], issues: [], steps: [] };
function step(name: string, action: () => void): void {
  try { action(); report.steps.push({ name, status: 'passed' }); report.results.push({ id: name, status: 'passed' }); }
  catch (error) { report.steps.push({ name, status: 'failed', error: String(error).slice(0, 800) }); report.results.push({ id: name, status: 'failed' }); }
}
step('fresh-m8', () => {
  execFileSync('pnpm', ['accept:m8', ...(process.argv.includes('--skip-e2e') ? ['--skip-e2e'] : [])], { stdio: 'inherit', env: { ...process.env, WDCC_ACCEPT_OUT: m8Out } });
  const m8 = JSON.parse(readFileSync(join(m8Out, 'report.json'), 'utf8')) as unknown;
  const issues = gateIssues(m8, identity, parseSpecIds());
  if (issues.length > 0) throw new Error(`M8 gate: ${issues.join(', ')}`);
});
step('l1-replay', () => {
  const value = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/l1-replay.ts', 'fixtures/traces'], { encoding: 'utf8' })) as { total: number; failures: unknown[]; fixtures: number };
  if (value.fixtures === 0 || value.total === 0 || value.failures.length !== 0) throw new Error('Empty or failed L1 report');
});
step('replay-browser', () => {
  if (process.argv.includes('--skip-e2e')) throw new Error('Replay browser suite not run');
  const m8 = JSON.parse(readFileSync(join(m8Out, 'report.json'), 'utf8')) as { buildRoot: string };
  const browserReport = join(out, `browser-${identity.runId}.json`);
  rmSync(browserReport, { force: true });
  execFileSync('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.m9.config.ts'], { stdio: 'inherit', env: { ...process.env, WDCC_WEB_DIST: join(m8.buildRoot, 'web'), WDCC_SERVER_ENTRY: join(m8.buildRoot, 'server/main.js'), M9_PLAYWRIGHT_JSON: browserReport } });
  const json = JSON.parse(readFileSync(browserReport, 'utf8')) as { stats?: { expected?: number; unexpected?: number; skipped?: number } };
  if (!json.stats?.expected || json.stats.unexpected || json.stats.skipped) throw new Error('Incomplete replay browser suite');
});
report.issues = gateIssues(report, createRunIdentity(identity.runId), report.expectedIds);
writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, commit: identity.commit, passed: report.issues.length === 0 }, null, 2) + '\n');
process.stdout.write(`M9: ${report.results.filter(result => result.status === 'passed').length}/${report.expectedIds.length}; ${report.issues.length} gate issues @ ${identity.commit}\n`);
if (report.issues.length > 0) process.exitCode = 1;

/** M8 runs fresh suites and writes a current report even when a step fails. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpecIds } from '../e2e-real/reporter.js';
import { createRunIdentity, gateIssues, parseRatchetBaseline, passSetIssues, type GateCase, type GateReport, type RunIdentity } from './lib/gate-report.js';

const ratchet = process.argv.includes('--ratchet');
const out = process.env['WDCC_ACCEPT_OUT'] ?? join(process.cwd(), 'docs/acceptance/M8');
const identity = createRunIdentity();
const expectedIds = parseSpecIds();
const report: GateReport = { formatVersion: 1, gate: ratchet ? 'M8-ratchet' : 'M8', identity, expectedIds, results: [], issues: [], steps: [] };
mkdirSync(out, { recursive: true });

function step(name: string, action: () => void): boolean {
  try { action(); report.steps.push({ name, status: 'passed' }); return true; }
  catch (error) { report.steps.push({ name, status: 'failed', error: String(error).slice(0, 800) }); return false; }
}
function run(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync('pnpm', args, { stdio: 'inherit', env });
}

for (const args of [['typecheck'], ['lint'], ['native:inventory'], ['test'], ['test:browser']]) step(args[0] ?? 'check', () => run(args));
const buildRoot = join(tmpdir(), `wdcc-accept-${identity.runId}`);
const web = join(buildRoot, 'web');
const server = join(buildRoot, 'server/main.js');
mkdirSync(web, { recursive: true });
symlinkSync(join(process.cwd(), 'node_modules'), join(buildRoot, 'node_modules'), 'dir');
try { symlinkSync(join(process.cwd(), 'packages/server/node_modules/better-sqlite3'), join(process.cwd(), 'node_modules/better-sqlite3'), 'dir'); } catch { /* Existing package link. */ }
const env = { ...process.env, WDCC_BUILD_DIR: web, WDCC_SERVER_OUT: server, WDCC_WEB_DIST: web, WDCC_SERVER_ENTRY: server, M8_RUN_ID: identity.runId, WDCC_ACCEPT_OUT: out };
const webBuilt = step('web-build', () => run(['--filter', '@webdcc/web', 'build'], env));
const serverBuilt = step('server-build', () => run(['exec', 'tsx', 'scripts/build-server.ts'], env));
const passes: { identity?: RunIdentity; results: GateCase[] }[] = [];
const count = ratchet ? 1 : 2;
if (webBuilt && serverBuilt && !process.argv.includes('--skip-e2e')) {
  step('browser-e2e', () => run(['e2e'], env));
  for (let pass = 1; pass <= count; pass++) {
    const file = join(out, `pass-${pass}.json`);
    rmSync(file, { force: true });
    step(`native-e2e-pass-${pass}`, () => run(['exec', 'playwright', 'test', '-c', 'playwright.real.config.ts'], { ...env, M8_PASS: String(pass) }));
    step(`read-pass-${pass}`, () => {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { identity?: RunIdentity; results: GateCase[] };
      if (!Array.isArray(data.results)) throw new Error('Invalid pass report');
      passes.push(data);
    });
  }
} else report.steps.push({ name: 'native-e2e', status: 'blocked', error: 'Build unavailable or E2E explicitly not run.' });
report.issues.push(...passSetIssues(passes, identity, expectedIds, count));
for (const id of expectedIds) {
  const results = passes.map(pass => pass.results.find(result => result.id === id));
  const worst = results.find(result => result !== undefined && result.status !== 'passed');
  const result = worst ?? results[0];
  report.results.push(result ?? { id, status: 'blocked' });
}

let issues = gateIssues(report, createRunIdentity(identity.runId), expectedIds);
if (ratchet) {
  const regressions: string[] = [];
  step('ratchet-baseline', () => {
    const path = process.env['WDCC_RATCHET_BASELINE'];
    const text = path === undefined ? execFileSync('git', ['show', 'origin/main:docs/acceptance/M8/status.json'], { encoding: 'utf8' }) : readFileSync(path, 'utf8');
    const baseline = parseRatchetBaseline(JSON.parse(text));
    for (const [id, status] of Object.entries(baseline)) {
      const current = report.results.find(result => result.id === id);
      if (status === 'passed' && (current?.status !== 'passed' || issues.some(issue => issue.includes(`:${id}`)))) regressions.push(`regression:${id}`);
      if (status !== 'not-implemented' && (current === undefined || current.status === 'not-implemented')) regressions.push(`implementation-removed:${id}`);
    }
  });
  const structural = issues.filter(issue => !/^(?:failed|not-implemented|not-triggered|blocked|missing-evidence|unverified-configuration):/.test(issue));
  issues = [...structural, ...regressions, ...report.steps.filter(step => step.status !== 'passed').map(step => `step:${step.name}:${step.status}`)];
}
report.issues = [...new Set(issues)];
const passedCount = report.results.filter(result => result.status === 'passed' && !issues.some(issue => issue.includes(`:${result.id}`))).length;
const executedCount = new Set(passes.flatMap(pass => pass.results.map(result => result.id))).size;
writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, commit: identity.commit, expectedCount: expectedIds.length, passedCount, executedCount, buildRoot, passed: issues.length === 0 }, null, 2) + '\n');
writeFileSync(join(out, 'status.json'), JSON.stringify(Object.fromEntries(report.results.map(result => [result.id, result.status])), null, 2) + '\n');
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>M8</title><h1>M8 ${passedCount}/${expectedIds.length}</h1><p>${identity.commit}</p><pre>${JSON.stringify(report.issues).replace(/</g, '&lt;')}</pre>`);
process.stdout.write(`M8: ${passedCount}/${expectedIds.length}; ${issues.length} gate issues @ ${identity.commit}\n`);
if (issues.length > 0) process.exitCode = 1;

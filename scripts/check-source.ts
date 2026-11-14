/** Source-only checks: isolated build paths, durable current evidence, no release. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRunIdentity, gateIssues, type GateReport } from './lib/gate-report.js';

const identity = createRunIdentity();
const out = join(process.cwd(), 'web_review/evidence');
const build = join(process.cwd(), '.artifacts', identity.runId);
mkdirSync(out, { recursive: true });
const checks: [string, string[]][] = [['typecheck', ['typecheck']], ['lint', ['lint']], ['native-inventory', ['native:inventory']], ['unit', ['test']], ['browser-security', ['test:browser']], ['build', ['build']]];
const report: GateReport = { formatVersion: 1, gate: 'source-only', identity, expectedIds: checks.map(([id]) => id), results: [], issues: [], steps: [] };
for (const [name, args] of checks) {
  const file = `${identity.runId}-${name}.log`;
  try {
    const output = execFileSync('pnpm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WDCC_COMMIT: identity.commit, WDCC_BUILT_AT: new Date().toISOString(), WDCC_BUILD_DIR: join(build, 'web'), WDCC_SERVER_OUT: join(build, 'server/main.js') } });
    writeFileSync(join(out, file), output);
    report.results.push({ id: name, status: 'passed', evidence: [file] });
    report.steps.push({ name, status: 'passed' });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    writeFileSync(join(out, file), `${failure.stdout ?? ''}\n${failure.stderr ?? String(error)}`);
    report.results.push({ id: name, status: 'failed', evidence: [file] });
    report.steps.push({ name, status: 'failed', error: String(error).slice(0, 500) });
  }
  process.stdout.write(`${name}: ${report.steps.at(-1)?.status}\n`);
}
report.issues = gateIssues(report, createRunIdentity(identity.runId), report.expectedIds);
writeFileSync(join(out, 'source-checks.json'), JSON.stringify({ ...report, passed: report.issues.length === 0, nativeAcceptance: 'not-run', deployment: 'not-performed-by-source-checks', buildRoot: build }, null, 2) + '\n');
if (report.issues.length > 0) process.exitCode = 1;

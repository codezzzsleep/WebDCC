import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';

export interface RunIdentity {
  runId: string;
  commit: string;
  sourceFingerprint: string;
  schemaFingerprint: string;
  configurationFingerprint: string;
  environment: { os: string; arch: string; node: string; nativeVersions: Record<string, string> };
}
export interface GateCase {
  id: string;
  status: 'passed' | 'failed' | 'not-implemented' | 'not-triggered' | 'blocked';
  requiredNativePredicates?: string[];
  nativePredicates?: Record<string, boolean>;
  uiActions?: string[];
  evidence?: string[];
}
export interface GateReport {
  formatVersion: 1;
  gate: string;
  identity: RunIdentity;
  expectedIds: string[];
  results: GateCase[];
  issues: string[];
  steps: { name: string; status: 'passed' | 'failed' | 'blocked'; error?: string }[];
}

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function sourceFingerprint(): string {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(path => /^(?:packages\/|scripts\/|e2e(?:-real)?\/|browser-tests\/|(?:package|pnpm-|tsconfig|vitest|playwright))/.test(path) && !path.includes('/dist/') && !path.includes('/node_modules/'));
  const digest = createHash('sha256');
  for (const path of [...new Set(files)].sort()) {
    try { digest.update(path).update('\0').update(readFileSync(path)).update('\0'); } catch { digest.update(`${path}:missing`); }
  }
  return digest.digest('hex');
}

export function createRunIdentity(runId: string = randomUUID()): RunIdentity {
  const version = (command: string): string => {
    try { return execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0] ?? 'unknown'; } catch { return 'unknown'; }
  };
  return { runId, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
    schemaFingerprint: hash(readFileSync('packages/server/src/native-inventory.json')),
    configurationFingerprint: process.env['WDCC_ACCEPT_CONFIG_FINGERPRINT'] ?? 'unverified',
    environment: { os: platform(), arch: arch(), node: process.version, nativeVersions: { codex: version('codex'), claude: version('claude'), dsh: version('dsh') } },
  };
}

export function gateIssues(value: unknown, current: RunIdentity, expectedIds: string[]): string[] {
  if (value === null || typeof value !== 'object') return ['unsupported-report-format'];
  const report = value as GateReport;
  if (report.formatVersion !== 1 || report.identity === undefined || report.identity === null || !Array.isArray(report.issues) || !Array.isArray(report.results) || !Array.isArray(report.expectedIds) || !Array.isArray(report.steps)) return ['unsupported-report-format'];
  if (report.results.some(result => result === null || typeof result.id !== 'string' || typeof result.status !== 'string') || report.steps.some(step => step === null || typeof step.name !== 'string')) return ['invalid-report-data'];
  const issues = [...report.issues];
  if (report.identity.commit !== current.commit) issues.push('stale-commit');
  if (report.identity.sourceFingerprint !== current.sourceFingerprint) issues.push('stale-source');
  if (report.identity.schemaFingerprint !== current.schemaFingerprint) issues.push('stale-schema');
  if (report.identity.configurationFingerprint !== current.configurationFingerprint) issues.push('different-configuration');
  if (expectedIds.length === 0 || report.results.length === 0) issues.push('empty-report');
  const expected = new Set(expectedIds);
  const actual = new Set(report.results.map(result => result.id));
  if (actual.size !== report.results.length) issues.push('duplicate-case-ids');
  for (const id of expected) if (!actual.has(id)) issues.push(`missing:${id}`);
  for (const id of actual) if (!expected.has(id)) issues.push(`unexpected:${id}`);
  if (report.expectedIds.length !== expected.size || report.expectedIds.some(id => !expected.has(id))) issues.push('different-manifest');
  for (const result of report.results) {
    if (result.status !== 'passed') issues.push(`${result.status}:${result.id}`);
    const required = [...new Set([...(result.requiredNativePredicates ?? []), ...requiredCasePredicates(result.id)])];
    for (const predicate of required) if (result.nativePredicates?.[predicate] !== true) issues.push(`not-triggered:${result.id}:${predicate}`);
    if (required.length > 0 && (!result.uiActions?.length || !result.evidence?.length)) issues.push(`missing-evidence:${result.id}`);
    if (required.length > 0 && report.identity.configurationFingerprint === 'unverified') issues.push(`unverified-configuration:${result.id}`);
  }
  for (const step of report.steps) if (step.status !== 'passed') issues.push(`step:${step.name}:${step.status}`);
  return [...new Set(issues)];
}

export function passSetIssues(passes: { identity?: RunIdentity; results: GateCase[] }[], current: RunIdentity, expectedIds: string[], requiredPasses: number): string[] {
  const issues: string[] = [];
  if (passes.length !== requiredPasses) issues.push('missing-pass');
  for (const [index, pass] of passes.entries()) {
    const ids = pass.results.map(result => result.id);
    if (ids.length !== new Set(ids).size || ids.length !== expectedIds.length || expectedIds.some(id => !ids.includes(id))) issues.push(`different-pass-ids:${index + 1}`);
    if (pass.identity?.runId !== current.runId || pass.identity?.sourceFingerprint !== current.sourceFingerprint || pass.identity?.commit !== current.commit) issues.push(`stale-pass:${index + 1}`);
  }
  return issues;
}

/** A legacy Boolean baseline cannot establish which scenarios were run. */
export function parseRatchetBaseline(value: unknown): Record<string, GateCase['status']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ratchet baseline');
  const result: Record<string, GateCase['status']> = {};
  for (const [id, status] of Object.entries(value)) {
    if (!['passed', 'failed', 'not-implemented', 'not-triggered', 'blocked'].includes(String(status))) throw new Error(`Invalid ratchet status: ${id}`);
    result[id] = status as GateCase['status'];
  }
  if (Object.keys(result).length === 0) throw new Error('Empty ratchet baseline');
  return result;
}

export function requiredCasePredicates(id: string): string[] {
  if (/^AG-.*-05$/.test(id)) return ['approval.request', 'approval.accepted', 'tool.effect'];
  if (/^AG-.*-09$/.test(id)) return ['turn.interrupted', 'approval.cancelled', 'turn.resumed'];
  if (/^AG-(codex|dsh)-14$|^AG-claude-13$/.test(id)) return ['question.request', 'question.answered'];
  return [];
}

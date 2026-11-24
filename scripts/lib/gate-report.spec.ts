import { describe, expect, it } from 'vitest';
import { gateIssues, parseRatchetBaseline, passSetIssues, type GateReport, type RunIdentity } from './gate-report.js';

const identity: RunIdentity = { runId: 'current', commit: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64), schemaFingerprint: 'c'.repeat(64), configurationFingerprint: 'd'.repeat(64), environment: { os: 'linux', arch: 'x64', node: '24', nativeVersions: {} } };
const report = (): GateReport => ({ formatVersion: 1, gate: 'test', identity, expectedIds: ['plain'], results: [{ id: 'plain', status: 'passed' }], issues: [], steps: [] });

describe('NP-15 evidence gates', () => {
  it('accepts current complete evidence and rejects old commit, source and schema', () => {
    expect(gateIssues(report(), identity, ['plain'])).toEqual([]);
    expect(gateIssues({ ...report(), identity: { ...identity, commit: 'old' } }, identity, ['plain'])).toContain('stale-commit');
    expect(gateIssues({ ...report(), identity: { ...identity, sourceFingerprint: 'old' } }, identity, ['plain'])).toContain('stale-source');
    expect(gateIssues({ ...report(), identity: { ...identity, schemaFingerprint: 'old' } }, identity, ['plain'])).toContain('stale-schema');
    expect(gateIssues({ commit: 'old', passedCount: 100 }, identity, ['plain'])).toContain('unsupported-report-format');
  });

  it('rejects empty reports, missing scenes, duplicate IDs and failed steps', () => {
    expect(gateIssues({ ...report(), results: [] }, identity, ['plain'])).toContain('empty-report');
    expect(gateIssues(report(), identity, ['plain', 'missing'])).toContain('missing:missing');
    expect(gateIssues({ ...report(), results: [...report().results, ...report().results] }, identity, ['plain'])).toContain('duplicate-case-ids');
    expect(gateIssues({ ...report(), steps: [{ name: 'browser', status: 'blocked' }] }, identity, ['plain'])).toContain('step:browser:blocked');
  });

  it('does not accept an approval scene without request, response, effect and UI evidence', () => {
    const id = 'AG-codex-05';
    const value = { ...report(), expectedIds: [id], results: [{ id, status: 'passed' as const }] };
    expect(gateIssues(value, identity, [id])).toContain(`not-triggered:${id}:approval.request`);
    value.results = [{ id, status: 'passed', ...{ nativePredicates: { 'approval.request': true, 'approval.accepted': true, 'tool.effect': true }, uiActions: ['approve'], evidence: ['native-log'] } }];
    expect(gateIssues(value, identity, [id])).toEqual([]);
  });

  it('requires the same current IDs in both passes and rejects Boolean or absent ratchet baselines', () => {
    const pass = { identity, results: report().results };
    expect(passSetIssues([pass, pass], identity, ['plain'], 2)).toEqual([]);
    expect(passSetIssues([pass, { ...pass, results: [] }], identity, ['plain'], 2)).toContain('different-pass-ids:2');
    expect(passSetIssues([pass], identity, ['plain'], 2)).toContain('missing-pass');
    expect(() => parseRatchetBaseline({ plain: true })).toThrow('Invalid ratchet');
    expect(() => parseRatchetBaseline({})).toThrow('Empty');
    expect(parseRatchetBaseline({ plain: 'passed' })).toEqual({ plain: 'passed' });
  });
});

it('rejects missing, malformed and different target/native environments in reports and repeated passes', () => {
  const actual = { ...identity, environment: { os: 'linux', arch: 'x64', node: 'v26.13.0', nativeVersions: { codex: 'codex-cli 0.172.0', claude: '2.1.322 (Claude Code)', dsh: '0.2.2-rc.1' } } };
  const good = { ...report(), identity: actual };
  expect(gateIssues(good, actual, ['plain'])).toEqual([]);
  for (const environment of [undefined, null, [], {}, { ...actual.environment, nativeVersions: null }, { ...actual.environment, node: '' }, { ...actual.environment, nativeVersions: { codex: 'unknown' } }]) {
    expect(gateIssues({ ...good, identity: { ...actual, environment } }, actual, ['plain'])).toContain('invalid-environment');
    expect(passSetIssues([{ identity: { ...actual, environment } as RunIdentity, results: good.results }], actual, ['plain'], 1)).toContain('invalid-environment:pass:1');
  }
  for (const [key, value, expected] of [['os', 'darwin', 'different-os'], ['arch', 'arm64', 'different-arch'], ['node', 'v24.0.0', 'different-node'], ['nativeVersions', { ...actual.environment.nativeVersions, codex: 'codex-cli 0.999.0' }, 'different-native-versions']] as const) {
    const changed = { ...actual, environment: { ...actual.environment, [key]: value } };
    expect(gateIssues({ ...good, identity: changed }, actual, ['plain'])).toContain(expected);
    expect(passSetIssues([{ identity: changed, results: good.results }], actual, ['plain'], 1)).toContain(`${expected}:pass:1`);
  }
  expect(gateIssues({ ...good, identity: { ...actual, environment: { ...actual.environment, nativeVersions: {} } } }, actual, ['plain'])).toContain('different-native-versions');
  expect(passSetIssues([{ identity: { ...actual, schemaFingerprint: 'stale' }, results: good.results }], actual, ['plain'], 1)).toContain('stale-pass:1');
  expect(passSetIssues([{ identity: actual, results: [{ id: 'plain', status: 'not-triggered' }] }], actual, ['plain'], 1)).toContain('not-triggered:pass:1:plain');
});

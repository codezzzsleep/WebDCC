import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { Options, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent } from '@webdcc/protocol';
import { ClaudeAdapter } from '../src/adapter.js';
import { sourceFingerprint } from '../../../../scripts/lib/gate-report.js';

interface Wire { direction: string; frame: { type?: string; request_id?: string; request?: Record<string, unknown>; response?: { subtype: string; request_id: string; response?: unknown; error?: string } } }
async function controlled(mode: 'unknown' | 'known') {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-claude-dialog-sdk-')); const profile = join(root, 'profile'); await mkdir(profile);
  const runId = randomUUID(); const log = join(root, 'wire.jsonl'); await writeFile(log, '');
  const events: AdapterEvent[] = []; let child: ChildProcess | undefined;
  const adapter = new ClaudeAdapter({ env: { HOME: root, CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_USE_FOUNDRY: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
    ...(mode === 'unknown' ? {} : { dialogSpecs: { 'fixture-declared-dialog': {
      validateRequest(payload) { if (payload['fixture'] !== true) throw new Error('invalid controlled fixture'); },
      validateResult(result) { if (JSON.stringify(result) !== JSON.stringify({ exact: [false, null, 0, '中文'] })) throw new Error('invalid controlled result'); },
    } } }),
  });
  adapter.onEvent((_id, event) => events.push(event));
  const build = adapter.buildLaunchSpec.bind(adapter);
  vi.spyOn(adapter, 'buildLaunchSpec').mockImplementation(opts => {
    const spec = build(opts);
    return { ...spec, sdkOptions: { ...spec.sdkOptions, spawnClaudeCodeProcess: () => {
      child = spawn(process.execPath, [new URL('./fixtures/dialog-cli.mjs', import.meta.url).pathname, log, runId, mode], { cwd: root, stdio: 'pipe', env: { PATH: process.env['PATH'] } });
      return child as SpawnedProcess;
    } } as Options };
  });
  await adapter.create({ sessionId: runId, cwd: root, providerId: null });
  const rows = async (): Promise<Wire[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire);
  const response = async () => (await rows()).find(row => row.direction === 'sdk-to-cli' && row.frame.type === 'control_response' && row.frame.response?.request_id === `dialog-${runId}`)?.frame.response;
  return { adapter, root, runId, log, events, rows, response,
    async close(outcome: string) {
      await adapter.dispose(runId);
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child!.once('exit', () => resolve()));
      const bytes = await readFile(log); const evidence = process.env['WDCC_CLAUDE_DIALOG_EVIDENCE'];
      if (evidence) { const out = join(evidence, runId); await mkdir(out, { recursive: true }); await writeFile(join(out, 'wire.jsonl'), bytes);
        await writeFile(join(out, 'report.json'), JSON.stringify({ runId, mode, outcome, sourceFingerprint: sourceFingerprint(),
          scope: 'actual unmodified official SDK with controlled Node CLI protocol peer; no official CLI/model/Provider acceptance',
          sdkVersion: '0.3.322', advertisedFixtureCLIVersion: '2.1.322', officialCLIExecuted: false, wireSha256: createHash('sha256').update(bytes).digest('hex'),
          childExited: child !== undefined && (child.exitCode !== null || child.signalCode !== null), userPrompts: 0, modelRequests: 0, providerRequests: 0 }, null, 2) + '\n'); }
      await rm(root, { recursive: true, force: true });
    } };
}

it('actual SDK refuses an undeclared dialog without sending a user-cancelled settlement', async () => {
  const h = await controlled('unknown'); let outcome = 'failed';
  try {
    await expect.poll(h.response).toBeDefined(); const response = await h.response();
    expect(response?.subtype).toBe('error');
    expect(response?.response).toBeUndefined();
    expect(h.events.some(event => event.type === 'item.complete' && event.kind === 'notice' && event.data.nativeType === 'request_user_dialog/unsupported')).toBe(true);
    expect((await h.rows()).some(row => row.direction === 'sdk-to-cli' && row.frame.type === 'user')).toBe(false);
    outcome = 'passed';
  } finally { await h.close(outcome); }
}, 15_000);

it.each(['completed', 'cancelled'] as const)('actual SDK keeps a declared fixture dialog user %s response and its exact identity', async behavior => {
  const h = await controlled('known'); let outcome = 'failed';
  try {
    await expect.poll(() => h.adapter.nativeState(h.runId).interactions[0]?.requestId).toBe(`dialog-${h.runId}`);
    const exact = { exact: [false, null, 0, '中文'] };
    const submitted = await h.adapter.executeNativeControl(h.runId, { type: 'dialog', requestId: `dialog-${h.runId}`, behavior,
      ...(behavior === 'completed' ? { result: exact } : {}) });
    expect(submitted).toMatchObject({ submitted: true, confirmed: false });
    await expect.poll(h.response).toBeDefined(); expect((await h.response())?.response).toEqual(behavior === 'completed' ? { behavior, result: exact } : { behavior });
    expect(h.adapter.nativeState(h.runId).interactions[0]?.payload).toMatchObject({ dialogKind: 'fixture-declared-dialog', toolUseID: `tool-${h.runId}` });
    outcome = 'passed';
  } finally { await h.close(outcome); }
}, 15_000);

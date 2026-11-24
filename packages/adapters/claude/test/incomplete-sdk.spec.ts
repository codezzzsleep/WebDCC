import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Options, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent } from '@webdcc/protocol';
import { ClaudeAdapter } from '../src/adapter.js';
import { sourceFingerprint } from '../../../../scripts/lib/gate-report.js';

it('actual unmodified SDK transports native aborted blocks without losing partial content or inventing a running tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-claude-incomplete-sdk-')); const profile = join(root, 'profile'); await mkdir(profile);
  const runId = randomUUID(), log = join(root, 'wire.jsonl'); await writeFile(log, '');
  const events: AdapterEvent[] = []; let child: ChildProcess | undefined; let outcome = 'failed';
  const adapter = new ClaudeAdapter({ env: { HOME: root, CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_USE_FOUNDRY: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } });
  adapter.onEvent((_id, event) => events.push(event)); const build = adapter.buildLaunchSpec.bind(adapter);
  vi.spyOn(adapter, 'buildLaunchSpec').mockImplementation(opts => { const spec = build(opts);
    return { ...spec, sdkOptions: { ...spec.sdkOptions, spawnClaudeCodeProcess: () => {
      child = spawn(process.execPath, [new URL('./fixtures/incomplete-sdk-peer.mjs', import.meta.url).pathname, log, runId], { cwd: root, stdio: 'pipe', env: { PATH: process.env['PATH'] } });
      return child as SpawnedProcess;
    } } as Options };
  });
  try {
    await adapter.create({ sessionId: runId, cwd: root, providerId: null });
    await expect.poll(() => events.filter(event => event.type === 'item.complete' && (event.kind === 'assistant.message' || event.kind === 'reasoning' || event.kind === 'tool.call')).length).toBe(5);
    const partial = events.filter(event => event.type === 'item.complete' && (event.kind === 'assistant.message' || event.kind === 'reasoning')
      && (event.data as { incomplete?: boolean }).incomplete === true);
    expect(partial).toHaveLength(2);
    expect(partial.map(event => (event.data as { text?: string }).text)).toEqual(['ACTUAL SDK PARTIAL', 'ACTUAL SDK PARTIAL THOUGHT']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'tool.call', data: expect.objectContaining({ name: 'Read', status: 'unknown', incomplete: true }) }));
    expect(events.some(event => event.type === 'item.start' && event.kind === 'file.read')).toBe(false);
    expect(events.find(event => event.type === 'item.complete' && event.kind === 'assistant.message' && (event.data as { text?: string }).text === 'ACTUAL SDK COMPLETE')).toMatchObject({ data: { text: 'ACTUAL SDK COMPLETE' } });
    outcome = 'passed';
  } finally {
    await adapter.dispose(runId);
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child!.once('exit', () => resolve()));
    const evidence = process.env['WDCC_CLAUDE_INCOMPLETE_SDK_EVIDENCE'];
    if (evidence) { const out = join(evidence, runId); await mkdir(out, { recursive: true }); const bytes = await readFile(log);
      await writeFile(join(out, 'wire.jsonl'), bytes); await writeFile(join(out, 'report.json'), JSON.stringify({ runId, outcome, sourceFingerprint: sourceFingerprint(),
        sdkVersion: '0.3.322', fixtureAdvertisedCLIVersion: '2.1.322', scope: 'Actual unmodified SDK transport with controlled Node protocol peer; not officialCLI/model/Provider/target',
        officialCLIExecuted: false, userPrompts: 0, modelRequests: 0, providerRequests: 0, wireSha256: createHash('sha256').update(bytes).digest('hex'),
        childExited: child !== undefined && (child.exitCode !== null || child.signalCode !== null) }, null, 2) + '\n'); }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

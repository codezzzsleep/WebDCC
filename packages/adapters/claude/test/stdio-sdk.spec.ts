import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { TraceFrame } from '@webdcc/protocol';
import { ClaudeAdapter } from '../src/adapter.js';
import { record } from '../src/native.js';

async function isolated() {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-claude-stdio-sdk-'));
  const profile = join(root, 'profile'); await mkdir(profile);
  const adapter = new ClaudeAdapter({ env: { HOME: root, CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } });
  return { root, adapter };
}

it('actual SDK initialization exposes raw request/response pairs through public stdio without a model turn or private ACK projection', async () => {
  const { root, adapter } = await isolated(); const frames: TraceFrame[] = [];
  try {
    await adapter.create({ sessionId: 'stdio', cwd: root, providerId: null, nativeEvents: { record: frame => { frames.push(frame); return { envelopeId: frames.length, accepted: true }; } } });
    const catalog = await adapter.nativeCatalog('stdio');
    expect(catalog.cliVersion).toBe('2.1.322');
    expect(catalog.models.length).toBeGreaterThan(0);
    await expect(adapter.executeNativeControl('stdio', { type: 'mcp-reconnect', serverName: '__webdcc_missing_capture_fixture__' })).rejects.toThrow();
    const outgoing = frames.filter(frame => frame.ch === 'claude-stdio:stdin').map(frame => record(record(frame.frame)['frame']));
    const incoming = frames.filter(frame => frame.ch === 'claude-stdio:stdout').map(frame => record(record(frame.frame)['frame']));
    const initialization = outgoing.find(frame => frame['type'] === 'control_request' && record(frame['request'])['subtype'] === 'initialize');
    expect(initialization).toBeDefined();
    expect(incoming.some(frame => frame['type'] === 'control_response' && record(frame['response'])['request_id'] === initialization?.['request_id'])).toBe(true);
    expect(incoming.some(frame => frame['type'] === 'control_response' && record(frame['response'])['subtype'] === 'error')).toBe(true);
    expect(outgoing.some(frame => frame['type'] === 'user')).toBe(false);
    expect(adapter.nativeState('stdio').stdioCapture).toMatchObject({ enabled: true, failed: false, privateControlsAcknowledgeInteractions: false });
    expect(adapter.nativeState('stdio').interactions).toEqual([]);
    console.info(JSON.stringify({ proof: 'actual-sdk-stdio-init', cli: catalog.cliVersion, sdk: '0.3.322', rawRequests: outgoing.filter(frame => frame['type'] === 'control_request').length,
      rawResponses: incoming.filter(frame => frame['type'] === 'control_response').length, rawErrorObserved: incoming.some(frame => record(frame['response'])['subtype'] === 'error'), userPrompts: 0, paidModel: false }));
  } finally { await adapter.dispose('stdio'); await rm(root, { recursive: true, force: true }); }
}, 30000);

it('raw NativeFrameSink rejection fences later user input without changing already observed stdio bytes', async () => {
  const { root, adapter } = await isolated(); let raw = 0; let userInputs = 0;
  try {
    await adapter.create({ sessionId: 'rejected', cwd: root, providerId: null, nativeEvents: { record: frame => {
      if (frame.ch === 'claude-stdio:stdin') { raw++; if (record(record(frame.frame)['frame'])['type'] === 'user') userInputs++; }
      return { envelopeId: raw, accepted: !frame.ch.startsWith('claude-stdio:') };
    } } });
    // Initialization is a public SDK read; the observer's rejection never rewrites its bytes.
    await adapter.nativeCatalog('rejected');
    expect(raw).toBeGreaterThan(0);
    expect(adapter.nativeState('rejected').stdioCapture.failed).toBe(true);
    await expect(adapter.send('rejected', { text: 'must never reach native' })).rejects.toMatchObject({ code: 'uncertain', statusCode: 503 });
    expect(userInputs).toBe(0);
  } finally { await adapter.dispose('rejected'); await rm(root, { recursive: true, force: true }); }
}, 30000);

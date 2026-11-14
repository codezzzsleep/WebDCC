import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ClaudeAdapter, PINNED_CLI_VERSION, resolveNativeCli } from '../src/adapter.js';
import { ClaudeNativeHistory } from '../src/native.js';

it('actual pinned Claude CLI answers SDK supportedModels without receiving a user prompt or using a production profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webdcc-claude-catalog-'));
  const profile = join(root, 'profile');
  await mkdir(profile);
  const adapter = new ClaudeAdapter({ env: { HOME: root, CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
    catalogOptions: async providerId => ({ sessionId: 'catalog-only', cwd: root, providerId }),
  });
  try {
    const probe = await adapter.probe();
    expect(probe.compatible).toBe(true);
    expect(probe.version).toBe('0.3.322');
    expect(probe.notes?.[0]).toContain(PINNED_CLI_VERSION);
    const models = await adapter.listModels(null);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(model => typeof model.id === 'string' && typeof model.label === 'string')).toBe(true);
    await adapter.create({ sessionId: 'isolated-native-catalog', cwd: root, providerId: null });
    const catalog = await adapter.nativeCatalog('isolated-native-catalog');
    expect(catalog.cliVersion).toBe(PINNED_CLI_VERSION);
    expect(catalog.models.map(model => model.value)).toEqual(models.map(model => model.id));
    // A real native control response, with no model turn or injected user instruction.
    expect(await adapter.executeNativeControl('isolated-native-catalog', { type: 'reload-skills' })).toBeDefined();
    await adapter.dispose('isolated-native-catalog');
    const binary = resolveNativeCli()!;
    const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    console.info(JSON.stringify({ proof: 'actual-sdk-initialization-catalog', cli: catalog.cliVersion, sdk: probe.version, binarySha256,
      models: models.map(model => model.id), isolatedProfile: true, userPrompts: 0, paidModel: false }));
  } finally { await adapter.dispose('isolated-native-catalog'); await rm(root, { recursive: true, force: true }); }
}, 30000);

it('SDK filesystem contracts read, paginate, rename/tag and fork temporary native transcripts through the isolated worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webdcc-claude-history-'));
  const cwd = join(root, 'workspace');
  const profile = join(root, 'profile');
  const nativeId = randomUUID();
  const userId = randomUUID();
  const assistantId = randomUUID();
  const project = join(profile, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const marker = join(cwd, 'untouched.txt');
  await mkdir(project, { recursive: true });
  await mkdir(cwd);
  await writeFile(marker, 'workspace content');
  const entries = [
    { type: 'user', uuid: userId, parentUuid: null, sessionId: nativeId, cwd, version: PINNED_CLI_VERSION, isSidechain: false, timestamp: '2026-11-14T01:00:00Z', message: { role: 'user', content: 'temporary history fixture' } },
    { type: 'assistant', uuid: assistantId, parentUuid: userId, sessionId: nativeId, cwd, version: PINNED_CLI_VERSION, isSidechain: false, timestamp: '2026-11-14T01:00:01Z', message: { role: 'assistant', id: 'native-message-id', content: [{ type: 'text', text: 'native fixture reply' }] } },
  ];
  await writeFile(join(project, `${nativeId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const history = new ClaudeNativeHistory({ HOME: root, CLAUDE_CONFIG_DIR: profile });
  try {
    const index = await history.list(cwd, 0, 1);
    expect(index.entries[0]?.sessionId).toBe(nativeId);
    const first = await history.messages(cwd, nativeId, 0, 1);
    expect(first.entries[0]?.uuid).toBe(userId);
    expect(first.hasMore).toBe(true);
    const second = await history.messages(cwd, nativeId, first.nextOffset, 1);
    expect(second.entries[0]?.uuid).toBe(assistantId);
    expect(second.hasMore).toBe(false);
    const before = await history.info(cwd, nativeId);
    const renamed = await history.mutate(cwd, nativeId, { type: 'rename', title: 'Native renamed title', revision: before.revision }) as { revision: string; customTitle: string };
    expect(renamed.customTitle).toBe('Native renamed title');
    await expect(history.mutate(cwd, nativeId, { type: 'tag', tag: 'stale', revision: before.revision })).rejects.toMatchObject({ statusCode: 409 });
    const tagged = await history.mutate(cwd, nativeId, { type: 'tag', tag: 'native-tag', revision: renamed.revision }) as { revision: string; tag: string };
    expect(tagged.tag).toBe('native-tag');
    const forked = await history.mutate(cwd, nativeId, { type: 'fork', messageId: assistantId, title: 'Native fork' }) as { sessionId: string };
    expect(forked.sessionId).not.toBe(nativeId);
    const forkMessages = (await history.messages(cwd, forked.sessionId, 0, 100)).entries;
    // The public SDK fork rewrites UUIDs and parent links for the new native session.
    expect(forkMessages.map(message => message.type)).toEqual(['user', 'assistant']);
    expect(forkMessages.map(message => message.message)).toEqual(entries.map(entry => entry.message));
    expect(forkMessages.every(message => message.uuid !== userId && message.uuid !== assistantId && message.session_id === forked.sessionId)).toBe(true);
    expect((await history.info(cwd, nativeId)).customTitle).toBe('Native renamed title');
    const deleteRevision = (await history.info(cwd, forked.sessionId)).revision;
    await history.mutate(cwd, forked.sessionId, { type: 'delete', revision: deleteRevision, confirmNativeId: forked.sessionId });
    expect(await readFile(marker, 'utf8')).toBe('workspace content');
    console.info(JSON.stringify({ proof: 'actual-sdk-filesystem-contract-temporary-fixture', paginated: true, renamed: true, tagged: true, forked: true,
      revisionConflict: true, productionHistory: false, paidModel: false }));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

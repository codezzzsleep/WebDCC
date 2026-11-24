import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/providers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import type { ImportedProvider } from '../src/provider-import.js';
import { defaultChoice, rememberModel } from '../../web/src/lib/agents.js';

const scanned = vi.hoisted(() => ({ candidates: [] as ImportedProvider[] }));
vi.mock('../src/provider-import.js', () => ({ scanLocalProviders: async () => scanned.candidates }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0)) await fn(); });
const native = (patch: Partial<ImportedProvider> = {}): ImportedProvider => ({ name: 'Native', source: 'codex-config', sourceKey: 'fixture', baseUrl: 'https://fixture.invalid/v1/',
  apiKey: 'sk-wdcc-test-old', protocols: ['openai-responses'], models: ['one'], nativeDefault: true, nativeDefaultModel: 'one', ...patch });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'provider-local-change-')); const db = openDb(':memory:'); const store = new Store(db); const registry = new ProviderRegistry(store, dir); await registry.init();
  cleanup.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const storage = new Map<string, string>(); vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  return { dir, store, registry };
}

it('key rotation changes unsaved defaults, preserves explicit choices and edits, and retains accurate update/ignore state across restart', async () => {
  const { dir, store, registry } = await fixture(); scanned.candidates = [native()]; await registry.scanLocal(); const old = registry.list()[0]!;
  await registry.update(old.id, { name: 'My edited label', modelDetails: [{ id: 'one', name: 'My model', reasoningEfforts: ['ultra'] }] });
  scanned.candidates = [native({ apiKey: 'sk-wdcc-test-new', models: ['two'], nativeDefaultModel: 'two' })];
  expect(await registry.scanLocal()).toEqual({ imported: 1, skipped: 0 });
  const current = registry.list().find(p => p.id !== old.id)!;
  expect(defaultChoice('codex', undefined, registry.list())).toMatchObject({ providerId: current.id, model: 'two' });
  expect(registry.runtimeConfig(current.id)?.apiKey).toBe('sk-wdcc-test-new');
  expect(registry.get(old.id)).toMatchObject({ name: 'My edited label', models: ['one'], localChange: { status: 'changed', replacementId: current.id } });
  expect(registry.runtimeConfig(old.id)?.apiKey).toBe('sk-wdcc-test-old');
  rememberModel('codex', old.id, 'one'); expect(defaultChoice('codex', undefined, registry.list()).providerId).toBe(old.id);
  await registry.resolveLocalChange(old.id, 'ignore');
  const restarted = new ProviderRegistry(store, dir); await restarted.init(); await restarted.scanLocal();
  expect(restarted.get(old.id)?.localChange?.status).toBe('ignored'); expect(store.listProviders()).toHaveLength(2);
  await restarted.resolveLocalChange(old.id, 'update');
  expect(restarted.runtimeConfig(old.id)?.apiKey).toBe('sk-wdcc-test-new');
  expect(restarted.get(old.id)).toMatchObject({ name: 'My edited label', models: ['one', 'two'], modelDetails: [expect.objectContaining({ name: 'My model', reasoningEfforts: ['ultra'] }), expect.any(Object)] });
  expect(restarted.get(old.id)?.localChange).toBeUndefined();
  await restarted.scanLocal(); expect(restarted.get(old.id)?.nativeDefault).toBe(true);
  expect(JSON.stringify(restarted.list())).not.toContain('sk-wdcc-test-');
});

it('native top-level Provider/model wins over oldest same-source imports, with normalized URL dedup', async () => {
  const { registry } = await fixture(); scanned.candidates = [native({ sourceKey: 'first', nativeDefault: false }), native({ sourceKey: 'current', baseUrl: 'https://current.invalid', apiKey: 'sk-wdcc-test-current', models: ['other', 'preferred'], nativeDefaultModel: 'preferred' })];
  await registry.scanLocal(); const selected = defaultChoice('codex', undefined, registry.list());
  expect(registry.get(selected.providerId!)?.sourceKey).toBe('current'); expect(selected.model).toBe('preferred');
  scanned.candidates = scanned.candidates.map(c => ({ ...c, baseUrl: c.baseUrl.replace(/\/+$/, '') })); await registry.scanLocal(); expect(registry.list()).toHaveLength(2);
});

it('Claude URL rotation remains one settings source and a new change resurfaces after ignoring the prior one', async () => {
  const { registry } = await fixture(); const claude = { source: 'claude-settings' as const, sourceKey: 'https://one.invalid', baseUrl: 'https://one.invalid', protocols: ['anthropic-messages'] };
  scanned.candidates = [native(claude)]; await registry.scanLocal(); const old = registry.list()[0]!;
  scanned.candidates = [native({ ...claude, sourceKey: 'https://two.invalid', baseUrl: 'https://two.invalid' })]; await registry.scanLocal();
  expect(registry.get(old.id)?.localChange?.status).toBe('changed'); await registry.resolveLocalChange(old.id, 'ignore');
  scanned.candidates = [native({ ...claude, sourceKey: 'https://two.invalid', baseUrl: 'https://two.invalid', apiKey: 'sk-wdcc-test-third' })]; await registry.scanLocal();
  expect(registry.get(old.id)?.localChange?.status).toBe('changed');
});

it('address+key dedup keeps one shared row and preserves each source native default', async () => {
  const { registry } = await fixture();
  scanned.candidates = [native(), native({ source: 'claude-settings', sourceKey: 'https://fixture.invalid/v1', protocols: ['anthropic-messages'], models: ['claude'], nativeDefaultModel: 'claude' })];
  await registry.scanLocal(); expect(registry.list()).toHaveLength(1);
  expect(defaultChoice('codex', undefined, registry.list()).model).toBe('one');
  expect(defaultChoice('claude-code', undefined, registry.list()).model).toBe('claude');
});

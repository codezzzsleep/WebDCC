import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFromClaude } from '../src/provider-import.js';
it('Claude companion model declarations preserve native inheritance instead of becoming the main model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-import-default-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', directory); vi.stubEnv('ANTHROPIC_MODEL', undefined);
  try {
    const file = join(directory, 'settings.json');
    const settings = { model: 'native-settings-model', env: { ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_AUTH_TOKEN: 'sk-wdcc-test-key', ANTHROPIC_SMALL_FAST_MODEL: 'companion-fast', ANTHROPIC_DEFAULT_OPUS_MODEL: 'companion-opus' } };
    const raw = JSON.stringify(settings); await writeFile(file, raw);
    expect((await importFromClaude())[0]).toMatchObject({ nativeDefault: true, nativeDefaultModel: '', models: ['companion-fast', 'companion-opus'] });
    expect(await readFile(file, 'utf8')).toBe(raw);
    await writeFile(file, JSON.stringify({ ...settings, env: { ...settings.env, ANTHROPIC_MODEL: 'native-main' } }));
    expect((await importFromClaude())[0]?.nativeDefaultModel).toBe('native-main');
  } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});

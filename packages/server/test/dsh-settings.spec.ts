import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateDshHomePatch } from '../src/dsh-settings.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('DSH home patch provider fallback', () => {
  it('只更新选中的 provider 和默认模型，并保留 patch 其他内容', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wdcc-dsh-settings-'));
    homes.push(home);
    const file = join(home, 'cordis.patch.yml');
    await writeFile(
      file,
      `- id: llm-pi-ai
  patch:
    providers:
      old-provider:
        baseURL: https://old.example/v1
        models:
          - id: old-model
            name: Old
      target:
        baseURL: https://target.example/v1
        reasoning: low
        models:
          - id: old-target
            name: Old Target
- id: agent-default-model
  patch:
    provider: old-provider
    model: old-model
- id: unrelated
  value: keep-me
`,
      { mode: 0o600 },
    );
    const previousHome = process.env['DSH_HOME'];
    process.env['DSH_HOME'] = home;
    try {
      await updateDshHomePatch({ providerKey: 'target', baseURL: 'https://new.example/v1', model: 'new-target', reasoning: 'high' });
    } finally {
      if (previousHome === undefined) delete process.env['DSH_HOME'];
      else process.env['DSH_HOME'] = previousHome;
    }
    const next = await readFile(file, 'utf8');
    expect(next).toContain('baseURL: https://new.example/v1');
    expect(next).toContain('- id: new-target');
    expect(next).toContain('name: new-target');
    expect(next).toContain('reasoning: high');
    expect(next).toContain('provider: target');
    expect(next).toContain('model: new-target');
    expect(next).toContain('old-provider:');
    expect(next).toContain('value: keep-me');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

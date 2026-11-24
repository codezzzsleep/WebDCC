import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { ProviderRegistry } from '../src/providers.js';
it('real SIGKILL after file staging and before SQL commit retains the original active credential and requires lock recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/provider-key-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let db: Db | undefined;
  try {
    await expect.poll(async () => { try { return JSON.parse(await readFile(join(directory, 'staged.json'), 'utf8')) as { providerId: string }; } catch { return undefined; } }).toMatchObject({ providerId: expect.any(String) });
    const { providerId } = JSON.parse(await readFile(join(directory, 'staged.json'), 'utf8')) as { providerId: string };
    const exit = once(child, 'exit'); child.kill('SIGKILL'); expect((await exit)[1]).toBe('SIGKILL');
    db = openDb(join(directory, 'source.sqlite')); const registry = new ProviderRegistry(new Store(db), directory);
    await expect(registry.init()).rejects.toMatchObject({ statusCode: 409 });
    await rm(join(directory, 'secrets.json.lock')); await registry.init();
    expect(registry.runtimeConfig(providerId)?.apiKey).toBe('sk-wdcc-test-old');
    await registry.update(providerId, { apiKey: 'sk-wdcc-test-recovered' });
    expect(registry.runtimeConfig(providerId)?.apiKey).toBe('sk-wdcc-test-recovered');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); db?.close(); await rm(directory, { recursive: true, force: true }); }
});

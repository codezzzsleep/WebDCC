import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DshConnectionStore, parseDshLink } from '../src/dsh-connection.js';

it('NP-10 preserves URL prefixes, validates saved credentials and keeps a cleared connection cleared after restart', async () => {
  expect(parseDshLink('https://example.test/dsh/?token=token')).toEqual({ url: 'https://example.test/dsh/', port: 443, token: 'token' });
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-dsh-connection-'));
  try {
    const first = new DshConnectionStore(directory);
    await first.init();
    await first.save({ url: 'https://example.test/dsh', cookie: 'dsh-auth-test=value', connectedAt: new Date().toISOString() });
    const loaded = new DshConnectionStore(directory);
    await loaded.init();
    expect(loaded.connection?.url).toBe('https://example.test/dsh/');
    await expect(loaded.save({ url: 'file:///tmp', cookie: 'value', connectedAt: new Date().toISOString() })).rejects.toMatchObject({ statusCode: 400 });
    expect(loaded.connection?.url).toBe('https://example.test/dsh/');
    await loaded.clear();
    const cleared = new DshConnectionStore(directory);
    await cleared.init();
    expect(cleared.connection).toBeNull();
    await writeFile(join(directory, 'dsh-connection.json'), '{}');
    await cleared.init();
    expect(cleared.connection).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

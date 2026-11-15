import { expect, it, vi } from 'vitest';
import { CodexAdapter, PINNED_VERSION } from '../src/adapter.js';

it('NP-01/46 incompatible native versions cannot create or resume a process', async () => {
  const adapter = new CodexAdapter();
  vi.spyOn(adapter, 'probe').mockResolvedValue({ installed: true, version: '0.168.0', pinnedVersion: PINNED_VERSION, compatible: false, auth: 'unknown' });
  const opts = { sessionId: 's', cwd: '/tmp/version-test', providerId: null };
  await expect(adapter.create(opts)).rejects.toMatchObject({ code: 'native-version-incompatible' });
  await expect(adapter.resume({ ...opts, nativeId: 'native' })).rejects.toMatchObject({ code: 'native-version-incompatible' });
  expect(adapter.debugProcesses()).toEqual([]);
});

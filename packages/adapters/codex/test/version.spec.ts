import { expect, it, vi } from 'vitest';
import { CodexAdapter, PINNED_VERSION } from '../src/adapter.js';
import { isSupportedCodexVersion } from '../src/versions.js';

it('NP-01/46 incompatible native versions cannot create or resume a process', async () => {
  const adapter = new CodexAdapter();
  vi.spyOn(adapter, 'probe').mockResolvedValue({ installed: true, version: '0.170.0', pinnedVersion: PINNED_VERSION, compatible: false, auth: 'unknown' });
  const opts = { sessionId: 's', cwd: '/tmp/version-test', providerId: null };
  await expect(adapter.create(opts)).rejects.toMatchObject({ code: 'native-version-incompatible' });
  await expect(adapter.resume({ ...opts, nativeId: 'native' })).rejects.toMatchObject({ code: 'native-version-incompatible' });
  expect(adapter.debugProcesses()).toEqual([]);
});

it('accepts reviewed releases while rejecting unknown, prerelease and older versions', () => {
  for (const version of ['0.167.0', '0.168.0', '0.169.0']) expect(isSupportedCodexVersion(version)).toBe(true);
  for (const version of [undefined, 'unknown', '0.166.0', '0.170.0', '0.169.1', '0.169.0-beta.1']) expect(isSupportedCodexVersion(version)).toBe(false);
});

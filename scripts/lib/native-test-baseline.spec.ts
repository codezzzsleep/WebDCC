import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { baselineTreeDigest, ensureNativeTestBaseline, fileDigest, type NativeBaselineSpec } from './native-test-baseline.js';

let directory: string; let archive: string; let source: string; let spec: NativeBaselineSpec;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wdcc-baseline-fixture-')); source = join(directory, 'source'); const pkg = join(source, 'package');
  await mkdir(join(pkg, 'vendor/bin'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: 'fixture-linux-x64' }));
  await writeFile(join(pkg, 'vendor/bin/codex'), '#!/bin/sh\nprintf "fixture-cli 1.0\\n"\n'); await chmod(join(pkg, 'vendor/bin/codex'), 0o755);
  await writeFile(join(pkg, 'vendor/helper'), 'original fixture helper'); await symlink('helper', join(pkg, 'vendor/helper-link'));
  archive = join(directory, 'fixture.tgz'); await promisify(execFile)('tar', ['-czf', archive, '-C', source, 'package']);
  spec = { packageVersion: 'fixture-linux-x64', cliVersion: 'fixture-cli 1.0', url: 'https://registry.npmjs.org/fixed-fixture.tgz',
    archiveIntegrity: `sha512-${await fileDigest(archive, 'sha512', 'base64')}`, binaryPath: 'vendor/bin/codex',
    binarySha256: await fileDigest(join(pkg, 'vendor/bin/codex')), treeSha256: await baselineTreeDigest(pkg), maxArchiveBytes: 4096 };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('installs an integrity-bound fixture package atomically and reuses it without a download', async () => {
  const root = join(directory, 'installed'); const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
  const initial = await ensureNativeTestBaseline({ root, archive, spec });
  expect(initial).toMatchObject({ version: 'fixture-cli 1.0', reused: false, source: 'archive' });
  expect(await readFile(join(root, 'package/vendor/helper'), 'utf8')).toBe('original fixture helper');
  expect((await ensureNativeTestBaseline({ root, spec })).reused).toBe(true); expect(fetcher).not.toHaveBeenCalled();
});

it('a damaged helper cannot be treated as the original distribution when the CLI itself is unchanged', async () => {
  const root = join(directory, 'installed'); await ensureNativeTestBaseline({ root, archive, spec });
  await writeFile(join(root, 'package/vendor/helper'), 'changed helper');
  await expect(ensureNativeTestBaseline({ root, archive, spec })).rejects.toThrow('资源指纹不匹配');
  expect(await readFile(join(root, 'package/vendor/helper'), 'utf8')).toBe('changed helper');
});

it('a corrupt archive is rejected without publishing a partial package', async () => {
  await writeFile(archive, 'corrupted archive'); const root = join(directory, 'installed');
  await expect(ensureNativeTestBaseline({ root, archive, spec })).rejects.toThrow('完整性校验失败');
  await expect(readFile(join(root, 'package/package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('a package printing the wrong CLI version is rejected even when its other fingerprints match', async () => {
  const root = join(directory, 'installed');
  await expect(ensureNativeTestBaseline({ root, archive, spec: { ...spec, cliVersion: 'fixture-cli 2.0' } })).rejects.toThrow('实际版本不匹配');
  await expect(readFile(join(root, 'package/package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('a verified explicit binary keeps its own path and causes no local installation or network request', async () => {
  const root = join(directory, 'unused'); const binary = join(source, 'package', spec.binaryPath);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
  expect(await ensureNativeTestBaseline({ root, binary, spec })).toMatchObject({ binary, reused: true, source: 'explicit-binary' });
  await expect(readFile(join(root, 'package/package.json'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(fetcher).not.toHaveBeenCalled();
});

it('the download path verifies and caches bytes; bad bytes are never installed', async () => {
  const bytes = await readFile(archive); const root = join(directory, 'downloaded');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
  expect(await ensureNativeTestBaseline({ root, spec })).toMatchObject({ source: 'download', reused: false });
  expect(fetcher).toHaveBeenCalledOnce(); expect(await fileDigest(join(root, 'distribution.tgz'))).toBe(createHash('sha256').update(bytes).digest('hex'));
  fetcher.mockResolvedValue(new Response('bad')); const invalidRoot = join(directory, 'bad-download');
  await expect(ensureNativeTestBaseline({ root: invalidRoot, spec })).rejects.toThrow('完整性校验失败');
  await expect(readFile(join(invalidRoot, 'package/package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

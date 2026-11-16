import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const run = promisify(execFile);
export interface NativeBaselineSpec {
  packageVersion: string; cliVersion: string; url: string; archiveIntegrity: string;
  binaryPath: string; binarySha256: string; treeSha256: string; maxArchiveBytes: number;
}
/** Original official Linux distribution; fingerprints include all resources,
 * executable modes and links, not only the version printed by one binary. */
export const CODEX_TEST_BASELINE: NativeBaselineSpec = {
  packageVersion: '0.167.0-linux-x64', cliVersion: 'codex-cli 0.167.0',
  url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-linux-x64.tgz',
  archiveIntegrity: 'sha512-FNc7danfUng9Sp6w+Fh7kofNHHZpA6VMyNKWsWrS3OwHly69gywTWeiuwrUPXpJSho8Df4xqRsHfHRPzj7zYQg==',
  binaryPath: 'vendor/x86_64-unknown-linux-musl/bin/codex',
  binarySha256: 'cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda',
  treeSha256: 'dd48151a1eaa4527126596c85dc5a5045b8bd58e755e500d0e96f5f2c3dd7cb9',
  maxArchiveBytes: 256 * 1024 * 1024,
};
export async function fileDigest(path: string, algorithm: 'sha256' | 'sha512' = 'sha256', encoding: 'hex' | 'base64' = 'hex'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest(encoding);
}
/** Npm tarballs describe files/links; directories are implicit and excluded. */
export async function baselineTreeDigest(root: string): Promise<string> {
  const entries: { path: string; value: string[] }[] = [];
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name); const rel = prefix === '' ? name : `${prefix}/${name}`; const info = await lstat(path);
      const mode = (info.mode & 0o7777).toString(8);
      if (info.isDirectory()) await walk(path, rel);
      else if (info.isFile()) entries.push({ path: rel, value: ['F', rel, mode, await fileDigest(path)] });
      else if (info.isSymbolicLink()) entries.push({ path: rel, value: ['L', rel, mode, await readlink(path)] });
      else throw new Error('基线发行包包含非普通资源');
    }
  };
  await walk(root); const hash = createHash('sha256');
  for (const entry of entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) hash.update(`${entry.value.join('\0')}\0`);
  return hash.digest('hex');
}
async function verifyPackage(root: string, spec: NativeBaselineSpec): Promise<string> {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (metadata.name !== '@openai/codex' || metadata.version !== spec.packageVersion) throw new Error('测试基线发行包版本不匹配');
  if (await baselineTreeDigest(root) !== spec.treeSha256) throw new Error('测试基线资源指纹不匹配，现有目录保留，不能作为原生基线');
  const binary = join(root, spec.binaryPath);
  if (await fileDigest(binary) !== spec.binarySha256) throw new Error('测试基线可执行文件指纹不匹配');
  const result = await run(binary, ['--version'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.stdout.trim() !== spec.cliVersion) throw new Error('测试基线 CLI 实际版本不匹配');
  return binary;
}
async function verifyArchive(path: string, spec: NativeBaselineSpec): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size > spec.maxArchiveBytes) throw new Error('基线归档超限或不是普通文件');
  if (`sha512-${await fileDigest(path, 'sha512', 'base64')}` !== spec.archiveIntegrity) throw new Error('测试基线归档完整性校验失败');
}
async function downloadArchive(path: string, spec: NativeBaselineSpec): Promise<void> {
  const uri = new URL(spec.url);
  if (uri.protocol !== 'https:' || uri.hostname !== 'registry.npmjs.org' || uri.username || uri.password || uri.search || uri.hash) throw new Error('基线下载来源必须是固定官方发行包');
  const response = await fetch(uri, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || response.body === null) throw new Error(`基线下载失败：HTTP ${response.status}`);
  let bytes = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length; callback(bytes > spec.maxArchiveBytes ? new Error('基线归档下载超限') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
}
export interface BaselineResult { binary: string; version: string; archiveIntegrity: string; treeSha256: string; reused: boolean; source: 'cache' | 'archive' | 'download' | 'explicit-binary'; }
export async function ensureNativeTestBaseline(options: { root: string; archive?: string; binary?: string; spec?: NativeBaselineSpec }): Promise<BaselineResult> {
  const spec = options.spec ?? CODEX_TEST_BASELINE;
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('固定原生测试基线当前只提供 Linux x64 发行包');
  const result = (binary: string, source: BaselineResult['source'], reused: boolean): BaselineResult => ({ binary, version: spec.cliVersion, archiveIntegrity: spec.archiveIntegrity, treeSha256: spec.treeSha256, source, reused });
  if (options.binary !== undefined) {
    const binary = resolve(options.binary); const suffix = `/${spec.binaryPath}`;
    if (!binary.endsWith(suffix)) throw new Error('显式测试基线必须指向完整固定发行包中的原始可执行文件');
    const packageRoot = binary.slice(0, -suffix.length);
    return result(await verifyPackage(packageRoot, spec), 'explicit-binary', true);
  }
  const root = resolve(options.root); const target = join(root, 'package');
  if (await lstat(target).catch(() => undefined)) return result(await verifyPackage(target, spec), 'cache', true);
  await mkdir(root, { recursive: true }); const stage = await mkdtemp(join(root, '.install-'));
  try {
    let archive: string; let source: BaselineResult['source'];
    if (options.archive !== undefined) { archive = resolve(options.archive); source = 'archive'; }
    else {
      archive = join(root, 'distribution.tgz'); source = 'download';
      if (!(await lstat(archive).catch(() => undefined))) {
        const temporary = join(root, `.download-${randomUUID()}.tgz`);
        try { await downloadArchive(temporary, spec); await verifyArchive(temporary, spec); await rename(temporary, archive); }
        finally { await rm(temporary, { force: true }); }
      } else source = 'cache';
    }
    await verifyArchive(archive, spec);
    const names = (await run('tar', ['-tzf', archive], { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 })).stdout.trim().split('\n');
    if (names.some(name => !name.startsWith('package/') || name.split('/').includes('..') || name.includes('\0'))) throw new Error('基线归档路径不合法');
    await run('tar', ['-xzf', archive, '--no-same-owner', '--same-permissions', '-C', stage], { timeout: 120_000 });
    await verifyPackage(join(stage, 'package'), spec);
    try { await rename(join(stage, 'package'), target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return result(await verifyPackage(target, spec), 'cache', true);
    }
    return result(join(target, spec.binaryPath), source, false);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

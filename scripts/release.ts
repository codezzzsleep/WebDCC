import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readlink, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const releaseRoot = process.env['WDCC_RELEASE_ROOT'] ?? '/opt/webdcc';
const dataDir = process.env['WDCC_DATA_DIR'] ?? '/home/webdcc/.webdcc';
const service = process.env['WDCC_SERVICE'] ?? 'webdcc.service';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '') throw new Error('发布要求工作区干净');
const remoteHead = execFileSync('git', ['ls-remote', 'origin', 'HEAD'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
if (remoteHead !== commit) throw new Error(`HEAD 尚未推送：本地 ${commit}，远端 ${remoteHead ?? 'unknown'}`);

const staging = join(tmpdir(), `wdcc-release-${commit}-${process.pid}`);
const checkout = join(staging, 'src');
await mkdir(staging, { recursive: true });
try {
  execFileSync('git', ['clone', '--quiet', '--no-local', '--branch', 'main', '.', checkout], { stdio: 'inherit' });
  execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout, stdio: 'inherit' });
  execFileSync('pnpm', ['build'], { cwd: checkout, stdio: 'inherit', env: { ...process.env, WDCC_COMMIT: commit, WDCC_BUILT_AT: new Date().toISOString() } });
  const target = join(releaseRoot, 'releases', commit);
  await mkdir(target, { recursive: true });
  await cp(join(checkout, 'packages/server/dist'), join(target, 'packages/server/dist'), { recursive: true });
  await cp(join(checkout, 'packages/web/dist'), join(target, 'packages/web/dist'), { recursive: true });
  await cp(join(checkout, 'node_modules'), join(target, 'node_modules'), { recursive: true, dereference: false });
  await cp(join(checkout, 'package.json'), join(target, 'package.json'));
  await cp(join(checkout, 'pnpm-lock.yaml'), join(target, 'pnpm-lock.yaml'));
  await mkdir(join(releaseRoot, 'backups'), { recursive: true });
  await cp(dataDir, join(releaseRoot, 'backups', `${commit}-${Date.now().toString(36)}`), { recursive: true });
  const current = join(releaseRoot, 'current');
  const previous = await readlinkSafe(current);
  await rm(current, { force: true });
  await symlink(target, current, 'dir');
  try {
    execFileSync('systemctl', ['restart', service], { stdio: 'inherit' });
    const base = process.env['WDCC_RELEASE_URL'] ?? 'http://127.0.0.1:8787';
    execFileSync('curl', ['--fail', '--silent', '--show-error', `${base}/`], { stdio: 'ignore' });
    const meta = JSON.parse(execFileSync('curl', ['--fail', '--silent', `${base}/api/meta`], { encoding: 'utf8' })) as { commit?: string };
    if (meta.commit !== commit) throw new Error(`线上 commit 不匹配：${meta.commit ?? 'missing'}`);
  } catch (error) {
    await rm(current, { force: true });
    if (previous !== undefined) await symlink(previous, current, 'dir');
    execFileSync('systemctl', ['restart', service], { stdio: 'inherit' });
    throw error;
  }
  const entries = (await readdir(join(releaseRoot, 'releases'))).sort().reverse();
  for (const old of entries.slice(5)) await rm(join(releaseRoot, 'releases', old), { recursive: true, force: true });
  process.stdout.write(`released ${commit} -> ${target}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function readlinkSafe(path: string): Promise<string | undefined> {
  try { return await (await lstat(path)).isSymbolicLink() ? readlink(path) : undefined; } catch { return undefined; }
}

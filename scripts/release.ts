import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, readlink, rm, symlink, lstat, writeFile } from 'node:fs/promises';
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
  const builtAt = new Date().toISOString();
  const target = join(releaseRoot, 'releases', commit);
  await mkdir(target, { recursive: true });
  await cp(join(checkout, 'packages/server/dist'), join(target, 'packages/server/dist'), { recursive: true });
  await cp(join(checkout, 'packages/web/dist'), join(target, 'packages/web/dist'), { recursive: true });
  await cp(join(checkout, 'node_modules'), join(target, 'node_modules'), { recursive: true, dereference: true });
  // The server bundle leaves native modules external. Workspace package
  // dependencies are linked from packages/server/node_modules, so the root
  // node_modules copy does not reliably include them (for example
  // better-sqlite3). Copy each runtime external to the release root where
  // Node resolves imports from packages/server/dist/main.js.
  await cp(
    join(checkout, 'packages/server/node_modules/better-sqlite3'),
    join(target, 'node_modules/better-sqlite3'),
    { recursive: true, dereference: true },
  );
  await cp(join(checkout, 'package.json'), join(target, 'package.json'));
  await cp(join(checkout, 'pnpm-lock.yaml'), join(target, 'pnpm-lock.yaml'));
  await writeFile(join(target, 'release.env'), `WDCC_COMMIT=${commit}\nWDCC_BUILT_AT=${builtAt}\n`);
  await mkdir(join(releaseRoot, 'backups'), { recursive: true });
  await cp(dataDir, join(releaseRoot, 'backups', `${commit}-${Date.now().toString(36)}`), { recursive: true });
  const current = join(releaseRoot, 'current');
  const previous = await readlinkSafe(current);
  await rm(current, { force: true });
  await symlink(target, current, 'dir');
  try {
    execFileSync('systemctl', ['restart', service], { stdio: 'inherit' });
    const base = process.env['WDCC_RELEASE_URL'] ?? 'http://127.0.0.1:80';
    const unauthStatus = execFileSync('curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', `${base}/`], { encoding: 'utf8' }).trim();
    if (unauthStatus !== '401') throw new Error(`未登录首页状态异常：${unauthStatus}`);
    const envFile = process.env['WDCC_ENV_FILE'] ?? '/etc/webdcc.env';
    const envText = await readFile(envFile, 'utf8').catch(() => '');
    const token = process.env['WDCC_TOKEN'] ?? /^WDCC_TOKEN=(.*)$/m.exec(envText)?.[1]?.trim();
    if (token === undefined || token === '') throw new Error('无法读取 WDCC_TOKEN，不能验证 /api/meta');
    const auth = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const setCookie = auth.headers.getSetCookie()[0]?.split(';')[0];
    if (setCookie === undefined) throw new Error('token 换 Cookie 失败');
    const metaResponse = await fetch(`${base}/api/meta`, { headers: { cookie: setCookie } });
    if (!metaResponse.ok) throw new Error(`/api/meta 状态异常：${metaResponse.status}`);
    const meta = await metaResponse.json() as { commit?: string };
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

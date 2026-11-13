import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, readlink, rename, rm, symlink, lstat, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

interface ReadonlyDb { prepare: (sql: string) => { get: () => unknown }; pragma: (sql: string, options: { simple: boolean }) => unknown; close: () => void }
type DatabaseConstructor = new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => ReadonlyDb;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const releaseRoot = process.env['WDCC_RELEASE_ROOT'] ?? '/opt/webdcc';
const dataDir = process.env['WDCC_DATA_DIR'] ?? '/home/webdcc/.webdcc';
const service = process.env['WDCC_SERVICE'] ?? 'webdcc.service';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '') throw new Error('发布要求工作区干净');
const remoteHead = execFileSync('git', ['ls-remote', 'origin', 'HEAD'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
if (remoteHead !== commit) throw new Error(`HEAD 尚未推送：本地 ${commit}，远端 ${remoteHead ?? 'unknown'}`);

const staging = join(tmpdir(), `wdcc-release-${commit}-${process.pid}`);
const checkout = join(staging, 'src');
let restartAttempted = false;
let maximumSchema = 0;

function activeTurnCount(): number {
    if (!existsSync(join(dataDir, 'webdcc.db'))) return 0;
    const db = new Database(join(dataDir, 'webdcc.db'), { readonly: true, fileMustExist: true });
    try {
      const schema = db.pragma('user_version', { simple: true }) as number;
      if (schema > maximumSchema) throw new Error(`数据库 ${schema} 与产物最大版本 ${maximumSchema} 不兼容`);
      const row = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status IN ('running', 'waiting')").get() as { count?: number };
      return Number(row.count ?? 0);
    } finally {
      db.close();
    }
}
await mkdir(staging, { recursive: true });
try {
  execFileSync('git', ['clone', '--quiet', '--no-local', '.', checkout], { stdio: 'inherit' });
  execFileSync('git', ['checkout', '--quiet', commit], { cwd: checkout, stdio: 'inherit' });
  execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout, stdio: 'inherit' });
  execFileSync('pnpm', ['build'], { cwd: checkout, stdio: 'inherit', env: { ...process.env, WDCC_COMMIT: commit, WDCC_BUILT_AT: new Date().toISOString() } });
  const manifest = JSON.parse(await readFile(join(checkout, 'packages/server/dist/build-manifest.json'), 'utf8')) as { commit: string; sourceFingerprint: string; schemaFingerprint: string; database: { minimum: number; maximum: number } };
  if (manifest.commit !== commit || !/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint) || !/^[a-f0-9]{64}$/.test(manifest.schemaFingerprint) || !Number.isSafeInteger(manifest.database.maximum)) throw new Error('构建清单不完整或提交不匹配');
  maximumSchema = manifest.database.maximum;
  const builtAt = new Date().toISOString();
  const target = join(releaseRoot, 'releases', commit);
  await mkdir(target, { recursive: true });
  await cp(join(checkout, 'packages/server/dist'), join(target, 'packages/server/dist'), { recursive: true });
  await cp(join(checkout, 'packages/web/dist'), join(target, 'packages/web/dist'), { recursive: true });
  await cp(join(checkout, 'node_modules'), join(target, 'node_modules'), { recursive: true, dereference: true });
  // pnpm keeps Claude Agent SDK's platform binary as an optional dependency
  // in the virtual-store hoist. The SDK resolves it relative to its own
  // package, so a release must also materialize the runtime package there;
  // copying the root node_modules alone leaves the binary present but
  // unresolvable and Claude fails with "Native CLI binary ... not found".
  const claudeSdkPackage = join(target, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const optionalSource = join(checkout, 'node_modules', '.pnpm', 'node_modules', '@anthropic-ai');
  const optionalTarget = join(claudeSdkPackage, 'node_modules', '@anthropic-ai');
  const optionalNames: string[] = await readdir(optionalSource).catch(() => [] as string[]);
  for (const name of optionalNames.filter((entry) => entry.startsWith('claude-agent-sdk-'))) {
    await cp(join(optionalSource, name), join(optionalTarget, name), { recursive: true, dereference: true });
  }
  if (optionalNames.includes('claude-agent-sdk-linux-x64')) {
    const binary = join(optionalTarget, 'claude-agent-sdk-linux-x64', 'claude');
    try {
      await stat(binary);
    } catch {
      throw new Error('发布包缺少 Claude Agent SDK linux-x64 原生 CLI');
    }
  }
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
  const activeBeforeSwitch = activeTurnCount();
  if (activeBeforeSwitch > 0) throw new Error(`当前有 ${activeBeforeSwitch} 个活动会话，发布已取消以避免中断执行`);
  await mkdir(join(releaseRoot, 'backups'), { recursive: true });
  await cp(dataDir, join(releaseRoot, 'backups', `${commit}-${Date.now().toString(36)}`), { recursive: true });
  const current = join(releaseRoot, 'current');
  const previous = await readlinkSafe(current);
  const activeBeforeRestart = activeTurnCount();
  if (activeBeforeRestart > 0) throw new Error(`当前有 ${activeBeforeRestart} 个活动会话，发布已取消以避免中断执行`);
  await switchCurrent(current, target);
  try {
    const activeAtRestart = activeTurnCount();
    if (activeAtRestart > 0) throw new Error(`当前有 ${activeAtRestart} 个活动会话，发布已取消以避免中断执行`);
    restartAttempted = true;
    execFileSync('systemctl', ['restart', service], { stdio: 'inherit' });
    const base = process.env['WDCC_RELEASE_URL'] ?? 'http://127.0.0.1:80';
    let unauthStatus = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        unauthStatus = execFileSync('curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', `${base}/`], { encoding: 'utf8' }).trim();
      } catch {
        unauthStatus = '';
      }
      if (unauthStatus === '401') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
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
    if (previous !== undefined) await switchCurrent(current, previous);
    else await rm(current, { force: true });
    if (restartAttempted) execFileSync('systemctl', ['restart', service], { stdio: 'inherit' });
    throw error;
  }
  const releasesDir = join(releaseRoot, 'releases');
  const entries = await Promise.all((await readdir(releasesDir)).map(async name => ({ name, modified: (await stat(join(releasesDir, name))).mtimeMs })));
  // Keep the release just activated even when commit hashes do not sort by
  // deployment time (the current commit may lexically precede older hashes).
  for (const old of entries.sort((a, b) => b.modified - a.modified).filter(entry => entry.name !== commit && join(releasesDir, entry.name) !== previous).slice(5)) await rm(join(releasesDir, old.name), { recursive: true, force: true });
  process.stdout.write(`released ${commit} -> ${target}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function readlinkSafe(path: string): Promise<string | undefined> {
  try { return await (await lstat(path)).isSymbolicLink() ? readlink(path) : undefined; } catch { return undefined; }
}

async function switchCurrent(current: string, target: string): Promise<void> {
  const stagedLink = `${current}.next-${process.pid}`;
  await rm(stagedLink, { force: true });
  try { await symlink(target, stagedLink, 'dir'); await rename(stagedLink, current); }
  finally { await rm(stagedLink, { force: true }); }
}

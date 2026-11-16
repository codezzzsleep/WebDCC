import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const serverRequire = createRequire(new URL('../packages/server/package.json', import.meta.url));
interface FixtureDb {
  exec(sql: string): void;
  prepare(sql: string): { run(value: string): unknown; get(): unknown };
  pragma(sql: string, options?: { simple: boolean }): unknown;
  close(): void;
}
const Database = serverRequire('better-sqlite3') as new (file: string, options?: { readonly: boolean }) => FixtureDb;
const sqliteModule = serverRequire.resolve('better-sqlite3');
const commit = 'a'.repeat(40);

interface ReleaseOptions {
  candidateMaximum?: number; previousMaximum?: number; migratedSchema?: number;
  candidateMinimum?: number; previousMinimum?: number; initialSchema?: number;
  previousManifest?: 'missing' | 'malformed'; changedManifest?: 'missing' | 'incompatible';
  firstRelease?: boolean; relativeLink?: boolean; healthy?: boolean; active?: boolean;
  failRestart?: boolean; failRollbackRestart?: boolean; failStop?: boolean;
}

async function failedRelease(options: ReleaseOptions = {}) {
  const candidateMaximum = options.candidateMaximum ?? 14;
  const previousMaximum = options.previousMaximum ?? 14;
  const migratedSchema = options.migratedSchema ?? candidateMaximum;
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-release-rollback-'));
  const root = join(scratch, 'release-root');
  const previous = join(root, 'releases', 'previous');
  const candidate = join(root, 'releases', commit);
  const data = join(scratch, 'data');
  const fixture = join(scratch, 'build');
  const bin = join(scratch, 'bin');
  const calls = join(scratch, 'service.jsonl');
  const manifest = (maximum: number, minimum = 0) => JSON.stringify({ commit, sourceFingerprint: 'b'.repeat(64), schemaFingerprint: 'c'.repeat(64), database: { minimum, maximum } });
  const http = createServer((request, response) => {
    if (request.url?.startsWith('/?token=')) response.setHeader('set-cookie', 'controlled-release-cookie=valid; HttpOnly');
    response.end(JSON.stringify({ commit: options.healthy ? commit : 'controlled-health-mismatch' }));
  });
  try {
    for (const directory of [previous, data, bin, join(fixture, 'packages/server/dist'), join(fixture, 'packages/web/dist'),
      join(fixture, 'node_modules/.pnpm/node_modules/@anthropic-ai'), join(fixture, 'packages/server/node_modules/better-sqlite3'),
      join(fixture, 'packages/server/node_modules/node-pty')]) await mkdir(directory, { recursive: true });
    // The real release layout nests manifests under packages/server/dist.
    await mkdir(join(previous, 'packages/server/dist'), { recursive: true });
    if (options.previousManifest !== 'missing') await writeFile(join(previous, 'packages/server/dist/build-manifest.json'),
      options.previousManifest === 'malformed' ? '{' : manifest(previousMaximum, options.previousMinimum));
    const previousLink = options.relativeLink ? 'releases/previous' : previous;
    if (!options.firstRelease) await symlink(previousLink, join(root, 'current'));
    await writeFile(join(fixture, 'packages/server/dist/build-manifest.json'), manifest(candidateMaximum, options.candidateMinimum));
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
    await writeFile(join(fixture, 'pnpm-lock.yaml'), 'controlled fixture');
    const db = new Database(join(data, 'webdcc.db'));
    db.exec('CREATE TABLE sessions (status TEXT)');
    db.pragma(`user_version = ${options.initialSchema ?? previousMaximum}`);
    if (options.active) db.prepare('INSERT INTO sessions VALUES (?)').run('running');
    db.close();
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const { cpSync } = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === 'rev-parse') process.stdout.write('${commit}\\n');
else if (args[0] === 'status' || args[0] === 'checkout') {}
else if (args[0] === 'ls-remote') process.stdout.write('${commit} HEAD\\n');
else if (args[0] === 'clone') cpSync(process.env.WDCC_ROLLBACK_FIXTURE, args[args.length - 1], { recursive: true });
else process.exitCode = 88;
`, { mode: 0o755 });
    await writeFile(join(bin, 'pnpm'), `#!${process.execPath}\n// Fixture build artifacts are already materialized.\n`, { mode: 0o755 });
    await writeFile(join(bin, 'curl'), `#!${process.execPath}\nprocess.stdout.write('401');\n`, { mode: 0o755 });
    await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const { readlinkSync, appendFileSync, rmSync, writeFileSync } = require('node:fs');
const Database = require(${JSON.stringify(sqliteModule)});
let target = null;
try { target = readlinkSync(process.env.WDCC_RELEASE_ROOT + '/current'); } catch {}
const db = new Database(process.env.WDCC_DATA_DIR + '/webdcc.db');
const isCandidate = target !== null && target.startsWith(process.env.WDCC_RELEASE_ROOT + '/releases/${commit}');
if (process.argv[2] === 'restart' && isCandidate) {
  db.pragma('user_version = ${migratedSchema}');
  db.exec("INSERT INTO sessions VALUES ('accepted-after-restart')");
  const previousManifest = process.env.WDCC_RELEASE_ROOT + '/releases/previous/packages/server/dist/build-manifest.json';
  if (${JSON.stringify(options.changedManifest)} === 'missing') rmSync(previousManifest);
  if (${JSON.stringify(options.changedManifest)} === 'incompatible') writeFileSync(previousManifest, ${JSON.stringify(manifest(13))});
}
appendFileSync(process.env.WDCC_ROLLBACK_CALLS, JSON.stringify({ operation: process.argv[2], target, schema: db.pragma('user_version', { simple: true }) }) + '\\n');
db.close();
if ((process.argv[2] === 'restart' && isCandidate && ${Boolean(options.failRestart)})
  || (process.argv[2] === 'restart' && !isCandidate && ${Boolean(options.failRollbackRestart)})
  || (process.argv[2] === 'stop' && ${Boolean(options.failStop)})) process.exitCode = 73;
`, { mode: 0o755 });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (address === null || typeof address === 'string') throw new Error('missing test server address');
    let stderr = '';
    let exitCode: number | string | undefined = 0;
    try {
      await run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./release.ts', import.meta.url))], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15000,
        env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, WDCC_RELEASE_ROOT: root, WDCC_DATA_DIR: data,
          WDCC_SERVICE: 'controlled-never-real-service', WDCC_ROLLBACK_FIXTURE: fixture, WDCC_ROLLBACK_CALLS: calls,
          WDCC_RELEASE_URL: `http://127.0.0.1:${address.port}`, WDCC_TOKEN: 'controlled-loopback-token' },
      });
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? '';
      exitCode = (error as { code?: number | string }).code;
    }
    const events = (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { operation: string; target: string; schema: number });
    const target = await readlink(join(root, 'current')).catch(() => undefined);
    const after = new Database(join(data, 'webdcc.db'), { readonly: true });
    const schema = after.pragma('user_version', { simple: true });
    const accepted = after.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'accepted-after-restart'").get() as { count: number };
    after.close();
    const activatedCandidate = events.find(event => event.operation === 'restart' && event.target !== previousLink)?.target ?? candidate;
    return { events, target, schema, stderr, exitCode, candidate: activatedCandidate, previous: previousLink, accepted: accepted.count };
  } finally {
    if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
}

it('refuses activation when the candidate schema exceeds the rollback artifact range', async () => {
  const result = await failedRelease({ previousMaximum: 13 });
  expect(result.exitCode).toBe(1);
  expect(result.events).toEqual([]);
  expect(result.target).toBe(result.previous);
  expect(result.schema).toBe(13);
  expect(result.stderr).toContain('回滚');
});

it.each(['missing', 'malformed'] as const)('rejects a %s rollback manifest before service activation', async previousManifest => {
  const result = await failedRelease({ previousManifest });
  expect(result.exitCode).toBe(1);
  expect(result.events).toEqual([]);
  expect(result.target).toBe(result.previous);
  expect(result.schema).toBe(14);
  expect(result.stderr).toContain('无法核验回滚产物');
});

it.each([
  { candidateMinimum: -1 }, { candidateMinimum: 15 }, { previousMinimum: 15 },
  { candidateMaximum: 14.5 }, { previousMaximum: 14.5, initialSchema: 14 },
])('rejects invalid manifest database ranges %j', async options => {
  const result = await failedRelease(options);
  expect(result.exitCode).toBe(1);
  expect(result.events).toEqual([]);
  expect(result.target).toBe(result.previous);
  expect(result.stderr).toMatch(/构建清单|兼容范围/);
});

it.each([
  { initialSchema: 13, previousMinimum: 14 },
  { initialSchema: 13, candidateMinimum: 14 },
  { initialSchema: 15 },
])('rejects databases outside the candidate or previous range %j', async options => {
  const result = await failedRelease(options);
  expect(result.exitCode).toBe(1);
  expect(result.events).toEqual([]);
  expect(result.target).toBe(result.previous);
  expect(result.schema).toBe(options.initialSchema);
});

it('rolls back to a compatible artifact and keeps post-restart database writes', async () => {
  const result = await failedRelease({ initialSchema: 13 });
  expect(result.exitCode).toBe(1);
  expect(result.events.map(event => event.operation)).toEqual(['restart', 'restart']);
  expect(result.events.map(event => event.target)).toEqual([result.candidate, result.previous]);
  expect(result.target).toBe(result.previous);
  expect(result.schema).toBe(14);
  expect(result.accepted).toBe(1);
  expect(result.stderr).toContain('线上 commit 不匹配');
});

it('resolves the rollback manifest relative to the current link', async () => {
  const result = await failedRelease({ relativeLink: true });
  expect(result.exitCode).toBe(1);
  expect(result.target).toBe('releases/previous');
  expect(result.events.map(event => event.operation)).toEqual(['restart', 'restart']);
});

it.each([
  { migratedSchema: 15 }, { changedManifest: 'missing' as const }, { changedManifest: 'incompatible' as const },
])('rechecks live schema and artifact before rollback %j', async options => {
  const result = await failedRelease(options);
  expect(result.exitCode).toBe(1);
  expect(result.events.map(event => event.operation)).toEqual(['restart', 'stop']);
  expect(result.events[0]?.target).toBe(result.candidate);
  expect(result.target).toBe(result.candidate);
  expect(result.schema).toBe(options.migratedSchema ?? 14);
  expect(result.accepted).toBe(1);
  expect(result.stderr).toContain('线上 commit 不匹配');
  expect(result.stderr).toContain('回滚未完成');
});

it('stops a failed first release instead of restarting a service without an artifact', async () => {
  const result = await failedRelease({ firstRelease: true, initialSchema: 13 });
  expect(result.exitCode).toBe(1);
  expect(result.events.map(event => event.operation)).toEqual(['restart', 'stop']);
  expect(result.events[1]?.target).toBeNull();
  expect(result.target).toBeUndefined();
  expect(result.schema).toBe(14);
  expect(result.accepted).toBe(1);
});

it('also checks rollback after a failed restart command', async () => {
  const result = await failedRelease({ failRestart: true });
  expect(result.exitCode).toBe(1);
  expect(result.events.map(event => event.operation)).toEqual(['restart', 'restart']);
  expect(result.target).toBe(result.previous);
  expect(result.stderr).toContain('restart controlled-never-real-service');
});

it('keeps the original failure when rollback restart and emergency stop fail', async () => {
  const result = await failedRelease({ failRollbackRestart: true, failStop: true });
  expect(result.exitCode).toBe(1);
  expect(result.events.map(event => event.operation)).toEqual(['restart', 'restart', 'stop']);
  expect(result.stderr).toContain('线上 commit 不匹配');
  expect(result.stderr).toContain('restart controlled-never-real-service');
  expect(result.stderr).toContain('stop controlled-never-real-service');
  expect(result.stderr).toContain('回滚未完成');
  expect(result.accepted).toBe(1);
});

it('keeps the active-session release guard', async () => {
  const result = await failedRelease({ active: true });
  expect(result.exitCode).toBe(1);
  expect(result.events).toEqual([]);
  expect(result.target).toBe(result.previous);
  expect(result.stderr).toContain('活动会话');
});

it.each([false, true])('still publishes a healthy compatible release (first=%s)', async firstRelease => {
  const result = await failedRelease({ healthy: true, firstRelease });
  expect(result.exitCode).toBe(0);
  expect(result.events.map(event => event.operation)).toEqual(['restart']);
  expect(result.target).toBe(result.candidate);
  expect(result.schema).toBe(14);
  expect(result.stderr).toBe('');
});


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
const Database = serverRequire('better-sqlite3') as new (file: string) => { exec(sql: string): void; pragma(sql: string): unknown; close(): void };
const commits = { A: 'a'.repeat(40), B: 'b'.repeat(40) };

async function overlappingRelease(independentRoot = false) {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-release-lock-'));
  const root = join(scratch, 'release-root');
  const secondaryRoot = independentRoot ? join(scratch, 'release-root-B') : root;
  const previous = join(root, 'releases', 'previous');
  const bin = join(scratch, 'bin');
  const data = join(scratch, 'data');
  const calls = join(scratch, 'service.jsonl');
  let atMeta!: () => void;
  const reachedMeta = new Promise<void>(resolve => { atMeta = resolve; });
  let unblockA!: () => void;
  const resumeA = new Promise<void>(resolve => { unblockA = resolve; });
  const http = createServer(async (request, response) => {
    const who = request.headers.cookie?.includes('fixture=A') ? 'A' : 'B';
    if (request.url?.startsWith('/?token=')) {
      const label = new URL(request.url, 'http://localhost').searchParams.get('token');
      response.setHeader('set-cookie', `fixture=${label}; HttpOnly`);
      response.end();
    } else {
      if (who === 'A') { atMeta(); await resumeA; }
      response.end(JSON.stringify({ commit: who === 'A' ? 'controlled-mismatch' : commits.B }));
    }
  });
  const pending: Promise<unknown>[] = [];
  try {
    for (const directory of [join(previous, 'packages/server/dist'), bin, data]) await mkdir(directory, { recursive: true });
    const manifest = (commit: string) => JSON.stringify({ commit, sourceFingerprint: 'c'.repeat(64), schemaFingerprint: 'd'.repeat(64), database: { minimum: 0, maximum: 14 } });
    await writeFile(join(previous, 'packages/server/dist/build-manifest.json'), manifest('e'.repeat(40)));
    await symlink(previous, join(root, 'current'));
    for (const label of ['A', 'B'] as const) {
      const fixture = join(scratch, label);
      for (const directory of [join(fixture, 'packages/server/dist'), join(fixture, 'packages/web/dist'),
        join(fixture, 'node_modules/.pnpm/node_modules/@anthropic-ai'), join(fixture, 'packages/server/node_modules/better-sqlite3'),
        join(fixture, 'packages/server/node_modules/node-pty')]) await mkdir(directory, { recursive: true });
      await writeFile(join(fixture, 'packages/server/dist/build-manifest.json'), manifest(commits[label]));
      await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
      await writeFile(join(fixture, 'pnpm-lock.yaml'), 'controlled fixture');
    }
    const db = new Database(join(data, 'webdcc.db'));
    db.exec('CREATE TABLE sessions (status TEXT)'); db.pragma('user_version=14'); db.close();
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const { cpSync } = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === 'rev-parse') process.stdout.write(process.env.WDCC_LOCK_COMMIT + '\\n');
else if (args[0] === 'status' || args[0] === 'checkout') {}
else if (args[0] === 'ls-remote') process.stdout.write(process.env.WDCC_LOCK_COMMIT + ' HEAD\\n');
else if (args[0] === 'clone') cpSync(process.env.WDCC_LOCK_FIXTURE, args.at(-1), { recursive: true });
else process.exitCode = 88;
`, { mode: 0o755 });
    await writeFile(join(bin, 'pnpm'), `#!${process.execPath}\n// Prebuilt controlled fixture.\n`, { mode: 0o755 });
    await writeFile(join(bin, 'curl'), `#!${process.execPath}\nprocess.stdout.write('401');\n`, { mode: 0o755 });
    await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const { appendFileSync, readlinkSync } = require('node:fs');
appendFileSync(process.env.WDCC_LOCK_CALLS, JSON.stringify({ label: process.env.WDCC_TOKEN, operation: process.argv[2], target: readlinkSync(process.env.WDCC_RELEASE_ROOT + '/current') }) + '\\n');
`, { mode: 0o755 });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (address === null || typeof address === 'string') throw new Error('missing test server');
    const execute = async (label: 'A' | 'B') => {
      try {
        const result = await run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./release.ts', import.meta.url))], {
          cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 12000,
          env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, WDCC_RELEASE_ROOT: label === 'B' ? secondaryRoot : root, WDCC_DATA_DIR: data,
            WDCC_SERVICE: 'controlled-never-real-service', WDCC_LOCK_COMMIT: commits[label], WDCC_LOCK_FIXTURE: join(scratch, label),
            WDCC_LOCK_CALLS: calls, WDCC_TOKEN: label, WDCC_RELEASE_URL: `http://127.0.0.1:${address.port}` },
        });
        return { code: 0, stderr: result.stderr };
      } catch (error) {
        return { code: (error as { code?: number | string }).code, stderr: (error as { stderr?: string }).stderr ?? '' };
      }
    };
    const first = execute('A'); pending.push(first);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([reachedMeta, first.then(result => { throw new Error(`A ended before meta: ${JSON.stringify(result)}`); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('A meta timeout')), 8000); })]);
    } finally { clearTimeout(timer); }
    const second = await execute('B');
    unblockA();
    const firstResult = await first;
    const afterFirst = await readlink(join(root, 'current'));
    const secondaryAfterFirst = independentRoot ? await readlink(join(secondaryRoot, 'current')) : undefined;
    const eventsBeforeRetry = await readFile(calls, 'utf8');
    const retry = await execute('B');
    return { firstResult, second, retry, afterFirst, secondaryAfterFirst, finalTarget: await readlink(join(secondaryRoot, 'current')),
      lockLeft: await readFile(join(root, '.release.lock/owner.json'), 'utf8').catch(() => undefined), previous, eventsBeforeRetry };
  } finally {
    unblockA(); await Promise.allSettled(pending);
    if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
}

it('rejects an overlapping publisher until the first verification and rollback finishes, then allows retry', async () => {
  const result = await overlappingRelease();
  expect(result.second.code).toBe(1);
  expect(result.second.stderr).toContain('发布锁');
  expect(result.firstResult.code).toBe(1);
  expect(result.afterFirst).toBe(result.previous);
  expect(result.eventsBeforeRetry).not.toContain('"label":"B"');
  expect(result.retry.code).toBe(0);
  expect(result.finalTarget).toContain(commits.B);
  expect(result.lockLeft).toBeUndefined();
});

it('permits independent release roots without letting one rollback undo the other', async () => {
  const result = await overlappingRelease(true);
  expect(result.second.code).toBe(0);
  expect(result.firstResult.code).toBe(1);
  expect(result.afterFirst).toBe(result.previous);
  expect(result.secondaryAfterFirst).toContain(commits.B);
  expect(result.retry.code).toBe(0);
  expect(result.lockLeft).toBeUndefined();
});

it.each(['directory', 'symlink', 'file'] as const)('does not steal or remove an existing %s release lock', async kind => {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-existing-release-lock-'));
  const root = join(scratch, 'release-root');
  const bin = join(scratch, 'bin');
  const lock = join(root, '.release.lock');
  const target = join(scratch, 'existing-lock-target');
  const original = JSON.stringify({ pid: 99999999, startedAt: '2000-01-01', commit: 'existing-owner' });
  try {
    await mkdir(root); await mkdir(bin);
    if (kind === 'file') await writeFile(lock, original);
    else {
      await mkdir(kind === 'symlink' ? target : lock);
      await writeFile(join(kind === 'symlink' ? target : lock, 'owner.json'), original);
      if (kind === 'symlink') await symlink(target, lock);
    }
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') process.stdout.write('${commits.B}\\n');
else if (args[0] === 'ls-remote') process.stdout.write('${commits.B} HEAD\\n');
else if (args[0] !== 'status') { require('node:fs').writeFileSync(process.env.WDCC_LOCK_UNEXPECTED, 'called'); process.exitCode = 88; }
`, { mode: 0o755 });
    const result = await run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./release.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, WDCC_RELEASE_ROOT: root,
        WDCC_LOCK_UNEXPECTED: join(scratch, 'unexpected'), WDCC_SERVICE: 'controlled-never-real-service', WDCC_DATA_DIR: join(scratch, 'data') },
    }).then(value => ({ code: 0, stderr: value.stderr }), (error: { code: number; stderr: string }) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('发布锁');
    expect(await readFile(kind === 'file' ? lock : join(lock, 'owner.json'), 'utf8')).toBe(original);
    expect(await readFile(join(scratch, 'unexpected'), 'utf8').catch(() => undefined)).toBeUndefined();
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

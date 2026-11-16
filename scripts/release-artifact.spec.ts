import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const serverRequire = createRequire(new URL('../packages/server/package.json', import.meta.url));
const Database = serverRequire('better-sqlite3') as new (file: string) => {
  exec(sql: string): void; pragma(sql: string): unknown; close(): void;
};
const commit = 'a'.repeat(40);

async function cancelledRelease(linked: boolean, options: { incompleteBuild?: boolean; healthy?: boolean; history?: boolean; relativeLink?: boolean } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-release-artifact-'));
  const root = join(scratch, 'release-root');
  const previous = join(root, 'releases', commit);
  const actual = linked ? join(scratch, 'external-artifact') : previous;
  const fixture = join(scratch, 'build');
  const bin = join(scratch, 'bin');
  const data = join(scratch, 'data');
  const calls = join(scratch, 'calls.jsonl');
  const http = createServer((request, response) => {
    if (request.url?.startsWith('/?token=')) response.setHeader('set-cookie', 'controlled-artifact-cookie=valid; HttpOnly');
    response.end(JSON.stringify({ commit }));
  });
  try {
    for (const directory of [join(root, 'releases'), join(actual, 'packages/server/dist'), data, bin,
      join(fixture, 'packages/server/dist'), join(fixture, 'packages/web/dist'),
      join(fixture, 'node_modules/.pnpm/node_modules/@anthropic-ai'),
      join(fixture, 'packages/server/node_modules/better-sqlite3'),
      ...(options.incompleteBuild ? [] : [join(fixture, 'packages/server/node_modules/node-pty')])]) {
      await mkdir(directory, { recursive: true });
    }
    if (linked) await symlink(actual, previous);
    const previousLink = options.relativeLink ? `releases/${commit}` : previous;
    await symlink(previousLink, join(root, 'current'));
    const manifest = JSON.stringify({ commit, sourceFingerprint: 'b'.repeat(64), schemaFingerprint: 'c'.repeat(64), database: { minimum: 0, maximum: 14 } });
    const original = 'active artifact bytes\r\n';
    await writeFile(join(actual, 'packages/server/dist/main.js'), original);
    await writeFile(join(actual, 'packages/server/dist/build-manifest.json'), manifest);
    await writeFile(join(actual, 'release.env'), 'original artifact metadata\n');
    if (options.history) {
      await utimes(actual, new Date('1990-01-01'), new Date('1990-01-01'));
      for (let index = 0; index < 9; index += 1) {
        const old = join(root, 'releases', `historical-${index}`);
        await mkdir(old);
        await utimes(old, new Date('2030-01-01'), new Date('2030-01-01'));
      }
    }
    await writeFile(join(fixture, 'packages/server/dist/main.js'), 'new build overwrites active bytes\n');
    await writeFile(join(fixture, 'packages/server/dist/build-manifest.json'), manifest);
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
    await writeFile(join(fixture, 'pnpm-lock.yaml'), 'controlled fixture');
    const db = new Database(join(data, 'webdcc.db'));
    db.exec('CREATE TABLE sessions (status TEXT)');
    if (!options.healthy) db.exec("INSERT INTO sessions VALUES ('running')");
    db.pragma('user_version = 14');
    db.close();
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const { cpSync } = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === 'rev-parse') process.stdout.write('${commit}\\n');
else if (args[0] === 'status' || args[0] === 'checkout') {}
else if (args[0] === 'ls-remote') process.stdout.write('${commit} HEAD\\n');
else if (args[0] === 'clone') cpSync(process.env.WDCC_ARTIFACT_FIXTURE, args.at(-1), { recursive: true });
else process.exitCode = 88;
`, { mode: 0o755 });
    await writeFile(join(bin, 'pnpm'), `#!${process.execPath}\n// Prebuilt controlled fixture.\n`, { mode: 0o755 });
    // Any service command or health probe is an unexpected failure in this
    // reproduction, which must stop before switching or restarting.
    for (const command of ['systemctl', 'curl']) await writeFile(join(bin, command), `#!${process.execPath}
const { appendFileSync, readlinkSync } = require('node:fs');
if (${Boolean(options.healthy)} && '${command}' === 'curl') process.stdout.write('401');
else {
  appendFileSync(process.env.WDCC_ARTIFACT_CALLS, JSON.stringify({ command: '${command}', target: readlinkSync(process.env.WDCC_RELEASE_ROOT + '/current') }) + '\\n');
  if (!${Boolean(options.healthy)}) process.exitCode = 88;
}
`, { mode: 0o755 });
    let base = 'http://127.0.0.1:1';
    if (options.healthy) {
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const address = http.address();
      if (address === null || typeof address === 'string') throw new Error('missing test server address');
      base = `http://127.0.0.1:${address.port}`;
    }
    let stderr = '';
    let stdout = '';
    let exitCode: number | string | undefined = 0;
    try {
      const result = await run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./release.ts', import.meta.url))], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15000,
        env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, WDCC_RELEASE_ROOT: root,
          WDCC_DATA_DIR: data, WDCC_SERVICE: 'controlled-never-real-service', WDCC_ARTIFACT_FIXTURE: fixture,
          WDCC_ARTIFACT_CALLS: calls, WDCC_RELEASE_URL: base, WDCC_TOKEN: 'controlled-loopback-token' },
      });
      stdout = result.stdout;
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? '';
      exitCode = (error as { code?: number | string }).code;
    }
    return { bytes: await readFile(join(actual, 'packages/server/dist/main.js'), 'utf8'),
      metadata: await readFile(join(actual, 'release.env'), 'utf8'), original,
      target: await readlink(join(root, 'current')), previous: previousLink, stdout,
      serviceCalls: await readFile(calls, 'utf8').catch(() => ''),
      releaseNames: await readdir(join(root, 'releases')), stderr, exitCode };
  } finally {
    if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
}

it.each([false, true])('preserves existing artifact bytes when same-commit release is cancelled (linked=%s)', async linked => {
  const result = await cancelledRelease(linked);
  expect(result.exitCode).toBe(1);
  expect(result.bytes).toBe(result.original);
  expect(result.metadata).toBe('original artifact metadata\n');
  expect(result.target).toBe(result.previous);
  expect(result.serviceCalls).toBe('');
  expect(result.stderr).toContain('活动会话');
  expect(result.releaseNames).toEqual([commit]);
});

it.each([false, true])('cleans only the new partial artifact after a dependency copy failure (linked=%s)', async linked => {
  const result = await cancelledRelease(linked, { incompleteBuild: true });
  expect(result.exitCode).toBe(1);
  expect(result.bytes).toBe(result.original);
  expect(result.metadata).toBe('original artifact metadata\n');
  expect(result.target).toBe(result.previous);
  expect(result.serviceCalls).toBe('');
  expect(result.releaseNames).toEqual([commit]);
  expect(result.stderr).toContain('ENOENT');
});

it.each([false, true])('publishes a new instance and retains current/previous while pruning (relative=%s)', async relativeLink => {
  const result = await cancelledRelease(false, { healthy: true, history: true, relativeLink });
  expect(result.exitCode).toBe(0);
  expect(result.bytes).toBe(result.original);
  expect(result.metadata).toBe('original artifact metadata\n');
  expect(result.target).not.toBe(result.previous);
  expect(result.target).toMatch(new RegExp(`/releases/${commit}-[a-f0-9-]+$`));
  expect(result.releaseNames).toContain(commit);
  expect(result.releaseNames).toContain(result.target.split('/').at(-1));
  expect(result.releaseNames).toHaveLength(7);
  expect(JSON.parse(result.serviceCalls)).toEqual({ command: 'systemctl', target: result.target });
  expect(result.stdout).toContain(`released ${commit} -> ${result.target}`);
});

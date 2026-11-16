import { fork, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { InteractionRecorder } from '../src/interaction-recorder.js';
import { readNativeDiagnosticContext, MAX_NATIVE_CONTEXT_BYTES } from '../src/native-diagnostic-context.js';

it.each(['fifo', 'missing', 'invalid', 'large', 'symlink', 'regular'])('NP-14 a %s context does not retain a finished native call and attribution stays truthful', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-context-fifo-'));
  const recorder = new InteractionRecorder(root); await recorder.init();
  const file = join(recorder.directory, 'context-native-fixture.json');
  if (kind === 'fifo') expect(spawnSync('mkfifo', [file]).status).toBe(0);
  if (kind === 'invalid') await writeFile(file, '{');
  if (kind === 'large') await writeFile(file, ' '.repeat(MAX_NATIVE_CONTEXT_BYTES + 1));
  const value = { sessionId: 's', nativeId: 'native-fixture', agent: 'dsh', cwd: root, workspaceId: 'w' };
  if (kind === 'regular') await writeFile(file, JSON.stringify(value));
  if (kind === 'symlink') { const external = join(root, 'outside.json'); await writeFile(external, JSON.stringify(value)); await symlink(external, file); }
  const upstream = createServer((_req, res) => res.end('native response'));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const child = fork(join(import.meta.dirname, 'fixtures/native-recorder-context.ts'), [`http://127.0.0.1:${port}/responses`], { execArgv: ['--import', 'tsx'], env: { ...process.env, WDCC_TRACE_DIR: recorder.directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  const exited = once(child, 'exit'); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); })]);
    expect(message).toEqual({ text: 'native response' });
    const finished = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 4000); })]);
    expect(finished).toBe(true); expect(child.exitCode).toBe(0);
    expect(await recorder.summary('s', 'native-fixture')).toMatchObject({ modelRequests: 1, incomplete: kind !== 'regular', errors: kind === 'regular' ? [] : [expect.stringContaining('context')] });
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); await exited; upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 15000);

it('NP-14 context reads preserve valid JSON and the exact size boundary, rejecting malformed UTF-8 and partial/oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-context-size-')); const file = join(root, 'context.json');
  try {
    await writeFile(file, '{}'+ ' '.repeat(MAX_NATIVE_CONTEXT_BYTES - 2));
    expect(await readNativeDiagnosticContext(file)).toEqual({ value: {} });
    await writeFile(file, '{}'+ ' '.repeat(MAX_NATIVE_CONTEXT_BYTES - 1));
    expect(await readNativeDiagnosticContext(file)).toEqual({ error: 'too-large' });
    for (const bytes of [Buffer.from('{'), Buffer.concat([Buffer.from('{"id":"'), Buffer.from([255]), Buffer.from('"}')])]) {
      await writeFile(file, bytes); expect(await readNativeDiagnosticContext(file)).toEqual({ error: 'invalid-json' });
    }
    const context = { nativeId: 'same-native-id', turnId: 'same-turn-id', nested: { unchanged: true } };
    await writeFile(file, JSON.stringify(context)); const before = await readFile(file);
    expect(await readNativeDiagnosticContext(file)).toEqual({ value: context }); expect(await readFile(file)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('NP-14 context readers close descriptors across repeated valid and special-file reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-context-fds-')); const file = join(root, 'context.json');
  try {
    await writeFile(file, '{}'); const before = (await readdir('/proc/self/fd')).length;
    for (let i = 0; i < 100; i++) {
      expect(await readNativeDiagnosticContext(file)).toEqual({ value: {} });
      expect(await readNativeDiagnosticContext('/dev/null')).toEqual({ error: 'not-regular' });
    }
    expect((await readdir('/proc/self/fd')).length).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('NP-14 a context socket is rejected without waiting for a peer or consuming content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-context-socket-')); const file = join(root, 'context.json');
  const server = createSocketServer();
  await new Promise<void>(resolve => server.listen(file, resolve));
  try { expect(await readNativeDiagnosticContext(file)).toEqual({ error: 'unavailable' }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

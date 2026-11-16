import { mkdtemp, readFile, rm, stat, symlink, writeFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DiagnosticFileWriter } from './diagnostic-writer.js';

async function terminateOwnedFixture(child: ChildProcess): Promise<void> {
  const descendants: { pid: number; start: string | undefined }[] = [];
  const identity = async (pid: number) => {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  };
  const collect = async (pid: number): Promise<void> => {
    try {
      const ids = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
      for (const id of ids) { descendants.push({ pid: id, start: await identity(id) }); await collect(id); }
    } catch { /* fixture may already have exited */ }
  };
  if (child.pid !== undefined) await collect(child.pid);
  for (const item of descendants.reverse()) {
    try { if (item.start !== undefined && await identity(item.pid) === item.start) process.kill(item.pid, 'SIGKILL'); } catch { /* owned process already ended */ }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

it('NP-14 limits queued writes and files without throwing into the native transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-diagnostic-quota-'));
  const file = join(root, 'trace.jsonl');
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  try {
    const writer = new DiagnosticFileWriter({ maxQueuedBytes: 6, maxFileBytes: 8 });
    const first = writer.write(file, 'first', 'append', onError);
    expect(writer.pendingBytes).toBe(5);
    await writer.write(file, 'second', 'append', onError);
    await first;
    expect(errors).toEqual(['Diagnostic write queue limit reached']);
    expect(await readFile(file, 'utf8')).toBe('first');
    await writer.write(file, 'too much', 'append', onError);
    await writer.write(file, 'more', 'append', onError);
    await writer.flush();
    expect(errors).toContain('Diagnostic file size limit reached');
    expect(await readFile(file, 'utf8')).toBe('first');
    expect(writer.pendingBytes).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('independent writers enforce one file limit across concurrent appends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-concurrency-'));
  const file = join(directory, 'trace.jsonl');
  const errors: string[] = [];
  try {
    const writers = Array.from({ length: 4 }, () => new DiagnosticFileWriter({ maxFileBytes: 64 }));
    await Promise.all(writers.map((writer, index) => writer.write(file, String(index).repeat(64), 'append', error => errors.push(error.message))));
    expect((await stat(file)).size).toBe(64);
    expect(errors).toEqual(Array.from({ length: 3 }, () => 'Diagnostic file size limit reached'));
    expect(writers.every(writer => writer.pendingBytes === 0)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('FIFO diagnostic targets fail and flush instead of retaining an owned writer indefinitely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-fifo-'));
  const file = join(directory, 'trace.jsonl');
  expect(spawnSync('mkfifo', [file]).status).toBe(0);
  const child = fork(join(import.meta.dirname, 'fixtures/diagnostic-writer-child.ts'), [file],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(child, 'message');
    const complete = once(child, 'message');
    child.send('go');
    const [result] = await Promise.race([complete, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('FIFO diagnostic write did not settle')), 2000); })]);
    expect(result).toMatchObject({ done: true, pendingBytes: 0, errors: ['Diagnostic target must be a regular file'] });
    expect((await stat(file)).isFIFO()).toBe(true);
    expect(spawnSync('flock', ['-n', join(directory, '.wdcc-diagnostic-writer.lock'), 'true']).status).toBe(0);
  } finally {
    clearTimeout(timer); await terminateOwnedFixture(child); await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it('symlink and socket targets fail without changing the referenced content or socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-special-'));
  const original = join(directory, 'original');
  const link = join(directory, 'trace.jsonl');
  const socket = join(directory, 'trace.socket');
  const server = createServer();
  try {
    await writeFile(original, 'original bytes'); await symlink(original, link);
    server.listen(socket); await once(server, 'listening');
    const writer = new DiagnosticFileWriter();
    const errors: string[] = [];
    await writer.write(link, 'replacement', 'replace', error => errors.push(error.message));
    await writer.write(socket, 'socket bytes', 'append', error => errors.push(error.message));
    await writer.flush();
    expect(errors).toEqual(['Diagnostic target must be a regular file', 'Diagnostic target must be a regular file']);
    expect(await readFile(original, 'utf8')).toBe('original bytes');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await lstat(socket)).isSocket()).toBe(true);
    expect(writer.pendingBytes).toBe(0);
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

it('a device created inside the isolated fixture is rejected without retaining its descriptor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-device-'));
  const file = join(directory, 'test-null-device');
  try {
    const created = spawnSync('mknod', [file, 'c', '1', '3']);
    expect(created.status, created.stderr?.toString()).toBe(0);
    const writer = new DiagnosticFileWriter(); const errors: string[] = [];
    await writer.write(file, 'device bytes', 'append', error => errors.push(error.message));
    await writer.flush();
    expect(errors).toEqual(['Diagnostic target must be a regular file']);
    expect((await lstat(file)).isCharacterDevice()).toBe(true);
    expect(writer.pendingBytes).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('mixed append and replacement check exact UTF-8 bytes before changing the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-replace-'));
  const file = join(directory, 'trace.jsonl');
  const errors: string[] = [];
  try {
    const first = new DiagnosticFileWriter({ maxFileBytes: 64 });
    const second = new DiagnosticFileWriter({ maxFileBytes: 64 });
    const report = (error: Error) => errors.push(error.message);
    await Promise.all([first.write(file, 'ré', 'replace', report), second.write(file, 'x'.repeat(61), 'append', report)]);
    await Promise.all([first.write(file, 'x'.repeat(65), 'replace', report), second.write(file, 'z', 'append', report)]);
    expect(await readFile(file, 'utf8')).toBe(`ré${'x'.repeat(61)}`);
    expect((await stat(file)).size).toBe(64);
    expect(errors).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('an unavailable lock utility returns incomplete diagnostics without rejected writes or retained bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-no-utility-'));
  const child = fork(join(import.meta.dirname, 'fixtures/diagnostic-writer-child.ts'), [join(directory, 'trace.jsonl')],
    { execArgv: ['--import', 'tsx'], env: { ...process.env, PATH: directory }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await once(child, 'message');
    const done = once(child, 'message'); const exited = once(child, 'exit'); child.send('go');
    const [value] = await done; await exited;
    expect(value).toMatchObject({ done: true, pendingBytes: 0, errors: ['Diagnostic file lock unavailable'] });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it('separate processes cannot all accept the same remaining file capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-processes-'));
  const file = join(directory, 'trace.jsonl');
  const children = Array.from({ length: 4 }, () => fork(join(import.meta.dirname, 'fixtures/diagnostic-writer-child.ts'), [file],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  try {
    await Promise.all(children.map(child => once(child, 'message')));
    const done = children.map(child => once(child, 'message'));
    const exited = children.map(child => once(child, 'exit'));
    for (const child of children) child.send('go');
    const results = await Promise.all(done);
    await Promise.all(exited);
    expect((await stat(file)).size).toBe(64);
    expect(results.flatMap(([value]) => (value as { errors: string[] }).errors)).toHaveLength(3);
    expect(results.every(([value]) => (value as { pendingBytes: number }).pendingBytes === 0)).toBe(true);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

it('an active lock fails with bounded diagnostics and is available after its owner finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-lock-'));
  const lock = join(directory, '.wdcc-diagnostic-writer.lock');
  const holder = spawn('flock', ['-x', lock, process.execPath, '-e', "process.stdout.write('ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await once(holder.stdout, 'data');
    const errors: string[] = [];
    const writer = new DiagnosticFileWriter();
    await writer.write(join(directory, 'trace.jsonl'), 'bounded', 'append', error => errors.push(error.message));
    expect(errors).toHaveLength(1);
    expect(writer.pendingBytes).toBe(0);
    const closed = once(holder, 'exit'); holder.stdin.end(); await closed;
    await writer.write(join(directory, 'trace.jsonl'), 'after release');
    expect(await readFile(join(directory, 'trace.jsonl'), 'utf8')).toBe('after release');
  } finally {
    holder.stdin.end(); if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it('a killed writer parent releases its owned helper without stealing any active lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-writer-kill-'));
  const file = join(directory, 'trace.jsonl');
  const lock = join(directory, '.wdcc-diagnostic-writer.lock');
  const child = fork(join(import.meta.dirname, 'fixtures/diagnostic-writer-child.ts'), [file, 'many'],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await once(child, 'message'); child.send('go');
    await expect.poll(() => spawnSync('flock', ['-n', lock, 'true']).status).toBe(1);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await expect.poll(() => spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
    const writer = new DiagnosticFileWriter({ maxFileBytes: 1024 * 1024 });
    const errors: string[] = [];
    await writer.write(file, 'recovered', 'replace', error => errors.push(error.message));
    await writer.flush();
    expect(errors).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('recovered');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

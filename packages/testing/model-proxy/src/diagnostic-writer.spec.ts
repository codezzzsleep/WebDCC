import { mkdtemp, readFile, rm, stat, symlink, writeFile, lstat, readdir, mkdir, utimes } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DiagnosticFileWriter, readDiagnosticDirectoryCoverage } from './diagnostic-writer.js';

it('expiration removes only old regular diagnostic files and keeps boundary, fresh and operator files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-diagnostic-expiration-'));
  const cutoff = 1_700_000_000_000;
  const expired = ['old.jsonl', 'context-old.json', 'coverage-old.json', 'model-old.coverage.json', '.wdcc-diagnostic-quota.json'];
  try {
    for (const name of expired) {
      const file = join(root, name); await writeFile(file, 'old');
      const date = new Date(cutoff - 5000); await utimes(file, date, date);
    }
    for (const name of ['fresh.jsonl', 'context-fresh.json', 'coverage-fresh.json', 'model-fresh.coverage.json', 'boundary.jsonl', 'operator-notes.txt']) {
      const file = join(root, name); await writeFile(file, name);
      const date = new Date(name === 'boundary.jsonl' ? cutoff : name === 'operator-notes.txt' ? cutoff - 5000 : cutoff + 5000);
      await utimes(file, date, date);
    }
    await mkdir(join(root, 'directory.jsonl'));
    await symlink(join(root, 'operator-notes.txt'), join(root, 'link.jsonl'));
    expect(spawnSync('mkfifo', [join(root, 'pipe.jsonl')]).status).toBe(0);
    const writer = new DiagnosticFileWriter();
    await writer.pruneExpired(root, cutoff);
    await writer.flush();
    for (const name of expired) await expect(lstat(join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of ['fresh.jsonl', 'context-fresh.json', 'coverage-fresh.json', 'model-fresh.coverage.json', 'boundary.jsonl', 'operator-notes.txt']) expect(await readFile(join(root, name), 'utf8')).toBe(name);
    expect((await lstat(join(root, 'directory.jsonl'))).isDirectory()).toBe(true);
    expect((await lstat(join(root, 'link.jsonl'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, 'pipe.jsonl'))).isFIFO()).toBe(true);
    expect((await stat(join(root, '.wdcc-diagnostic-writer.lock'))).isFile()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('serializes same-directory writes and repeated expiration without changing bytes or leaving a held lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-diagnostic-prune-order-'));
  const file = join(root, 'active.jsonl');
  try {
    await writeFile(file, 'expired');
    const old = new Date(Date.now() - 10_000); await utimes(file, old, old);
    const a = new DiagnosticFileWriter(), b = new DiagnosticFileWriter();
    const writes = [a.write(file, 'first', 'replace'), b.pruneExpired(root, Date.now() - 1000), a.write(file, '-second'), a.pruneExpired(root, Date.now() - 1000), b.write(file, '-third')];
    await Promise.all(writes);
    await Promise.all([a.flush(), b.flush()]);
    expect(await readFile(file, 'utf8')).toBe('first-second-third');
    expect(a.pendingBytes + b.pendingBytes).toBe(0);
    await Promise.all(Array.from({ length: 20 }, () => new DiagnosticFileWriter().pruneExpired(root, Date.now() - 1000)));
    expect(await readFile(file, 'utf8')).toBe('first-second-third');
    expect(spawnSync('flock', ['-n', join(root, '.wdcc-diagnostic-writer.lock'), process.execPath, '-e', '']).status).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

it('multiple files share a directory budget with a bounded persistent incomplete marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-directory-quota-'));
  const errors: string[] = [];
  try {
    const writers = Array.from({ length: 4 }, () => new DiagnosticFileWriter({ maxFileBytes: 64, maxDirectoryBytes: 128 }));
    await Promise.all(writers.map((writer, index) => writer.write(join(directory, `${index}.jsonl`), 'x'.repeat(64), 'append', error => errors.push(error.message))));
    const files = (await readdir(directory)).filter(name => name.endsWith('.jsonl'));
    expect(files).toHaveLength(2);
    expect(errors).toEqual(['Diagnostic directory size limit reached', 'Diagnostic directory size limit reached']);
    const marker = join(directory, '.wdcc-diagnostic-quota.json');
    expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ incomplete: true, scope: 'directory', failures: 2 });
    expect((await stat(marker)).size).toBeLessThanOrEqual(4096);
    const restarted = new DiagnosticFileWriter({ maxFileBytes: 64, maxDirectoryBytes: 128 });
    await restarted.write(join(directory, 'after-restart.jsonl'), 'x', 'append', error => errors.push(error.message));
    expect((await readdir(directory)).filter(name => name.endsWith('.jsonl'))).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('ordinary records cannot use the reserved directory coverage path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-directory-reserved-'));
  try {
    const writer = new DiagnosticFileWriter({ maxDirectoryBytes: 128 }); const errors: string[] = [];
    await writer.write(join(directory, '.wdcc-diagnostic-quota.json'), 'x'.repeat(512), 'append', error => errors.push(error.message));
    await writer.write(`${directory}/./.wdcc-diagnostic-quota.json`, 'x'.repeat(512), 'append', error => errors.push(error.message));
    expect(errors).toEqual(['Reserved diagnostic coverage path', 'Reserved diagnostic coverage path']);
    expect(writer.pendingBytes).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('directory budgets include old files and reclaim only successful replacement growth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-directory-existing-'));
  const errors: string[] = [];
  try {
    await writeFile(join(directory, 'unrelated.bin'), 'u'.repeat(96));
    const writer = new DiagnosticFileWriter({ maxDirectoryBytes: 128 });
    const file = join(directory, 'trace.jsonl');
    await writer.write(file, 'x'.repeat(32));
    await writer.write(join(directory, 'blocked.jsonl'), 'x', 'append', error => errors.push(error.message));
    await writer.write(file, 'x'.repeat(16), 'replace');
    const restarted = new DiagnosticFileWriter({ maxDirectoryBytes: 128 });
    await restarted.write(join(directory, 'next.jsonl'), 'x'.repeat(16), 'append', error => errors.push(error.message));
    expect(errors).toEqual(['Diagnostic directory size limit reached']);
    expect(await readFile(join(directory, 'unrelated.bin'), 'utf8')).toBe('u'.repeat(96));
    expect((await readdir(directory)).includes('blocked.jsonl')).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('zero budget does not create empty records and special coverage paths stay explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-directory-zero-'));
  try {
    const writer = new DiagnosticFileWriter({ maxDirectoryBytes: 0 });
    const errors: string[] = [];
    await writer.write(join(directory, 'blocked.jsonl'), 'x', 'append', error => errors.push(error.message));
    await writer.writeCoverage(join(directory, 'coverage.json'), JSON.stringify({ incomplete: true }), error => errors.push(error.message));
    expect((await readdir(directory)).filter(name => !name.startsWith('.'))).toEqual([]);
    const marker = join(directory, '.wdcc-diagnostic-quota.json');
    expect((await stat(marker)).size).toBeLessThanOrEqual(4096);
    expect(await readDiagnosticDirectoryCoverage(directory)).toMatchObject({ incomplete: true });
    await rm(marker); expect(spawnSync('mkfifo', [marker]).status).toBe(0);
    expect(await readDiagnosticDirectoryCoverage(directory)).toEqual({ incomplete: true, errors: ['Diagnostic directory coverage unavailable'] });
    await writer.write(join(directory, 'second.jsonl'), 'x', 'append', error => errors.push(error.message));
    expect(errors.at(-1)).toContain('coverage marker unavailable');
    expect(writer.pendingBytes).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('different-file writers in separate processes cannot reuse the directory capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-directory-processes-'));
  const children = Array.from({ length: 4 }, (_, index) => fork(join(import.meta.dirname, 'fixtures/diagnostic-writer-child.ts'),
    [join(directory, `${index}.jsonl`), 'single', '128'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  try {
    await Promise.all(children.map(child => once(child, 'message')));
    const done = children.map(child => once(child, 'message')); const exited = children.map(child => once(child, 'exit'));
    children.forEach(child => child.send('go'));
    const results = await Promise.all(done); await Promise.all(exited);
    expect((await readdir(directory)).filter(name => name.endsWith('.jsonl'))).toHaveLength(2);
    expect(results.flatMap(([value]) => (value as { errors: string[] }).errors)).toEqual([
      'Diagnostic directory size limit reached', 'Diagnostic directory size limit reached',
    ]);
    expect(JSON.parse(await readFile(join(directory, '.wdcc-diagnostic-quota.json'), 'utf8')),
      JSON.stringify(results.map(([value]) => value))).toMatchObject({ incomplete: true, failures: 2 });
  } finally { for (const child of children) await terminateOwnedFixture(child); await rm(directory, { recursive: true, force: true }); }
}, 20000);

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

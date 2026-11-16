import { fork, spawnSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.each([{ chunks: 4, activeBytes: 64 * 1024 * 1024 }, { chunks: 100, activeBytes: 64 * 1024 * 1024 }, { chunks: 4, activeBytes: 0 }])('NP-14 chunk metadata stays bounded while context waits, with limits $chunks/$activeBytes', async ({ chunks, activeBytes }) => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-native-metadata-'));
  const context = join(root, 'context-native-fixture.json');
  expect(spawnSync('mkfifo', [context]).status).toBe(0);
  let stream: ServerResponse | undefined; let sent = 0;
  const upstream = createServer((_req, res) => { stream = res; res.write('x'); sent++; });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const child = fork(join(import.meta.dirname, 'fixtures/native-recorder-stream.ts'), [`http://127.0.0.1:${port}/responses`], { execArgv: ['--import', 'tsx'], env: { ...process.env, WDCC_TRACE_DIR: root, WDCC_TRACE_MAX_CAPTURE_CHUNKS: String(chunks), WDCC_TRACE_MAX_ACTIVE_CAPTURE_BYTES: String(activeBytes) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  const exited = once(child, 'exit');
  const finished = new Promise<number>(resolve => { child.on('message', (value: { read?: boolean; done?: boolean; bytes?: number }) => {
    // Wait for actual native consumption before every next frame, so coalesced
    // network writes cannot hide an unbounded number of observer events.
    if (value.read) { if (sent === 50) stream!.end(); else { stream!.write('x'); sent++; } }
    if (value.done) resolve(value.bytes!);
  }); });
  try {
    const bytes = await Promise.race([finished, exited.then(() => { throw new Error(errors); })]);
    expect(bytes).toBe(50);
    await writeFile(context, '{}'); await exited; expect(child.exitCode).toBe(0);
    const rows = (await readFile(join(root, 'model-native-fixture.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.channel === 'chunk')).toHaveLength(Math.min(50, chunks));
    const terminal = rows.find(row => row.channel === 'complete').value.value;
    expect(terminal.coverage).toMatchObject({ responseBytes: 50, responseChunks: 50, omittedChunkEvents: Math.max(0, 50 - chunks), truncated: chunks < 50 || activeBytes === 0 });
    expect(terminal.chunks.length).toBe(chunks < 50 || activeBytes === 0 ? 0 : 50);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it.each([{ captureBytes: 10000, fileBytes: 1000000, directoryBytes: 512 * 1024 * 1024, activeBytes: 64 * 1024 * 1024 },
  { captureBytes: 8, fileBytes: 1000000, directoryBytes: 512 * 1024 * 1024, activeBytes: 64 * 1024 * 1024 },
  { captureBytes: 10000, fileBytes: 64, directoryBytes: 512 * 1024 * 1024, activeBytes: 64 * 1024 * 1024 },
  { captureBytes: 10000, fileBytes: 1000000, directoryBytes: 0, activeBytes: 64 * 1024 * 1024 },
  { captureBytes: 10000, fileBytes: 1000000, directoryBytes: 128, activeBytes: 64 * 1024 * 1024 },
  { captureBytes: 10000, fileBytes: 1000000, directoryBytes: 512 * 1024 * 1024, activeBytes: 0 },
  { captureBytes: 10000, fileBytes: 1000000, directoryBytes: 128, activeBytes: 0 }])('NP-14 native preload preserves transport with capture/file/directory/active limits $captureBytes/$fileBytes/$directoryBytes/$activeBytes', async ({ captureBytes, fileBytes, directoryBytes, activeBytes }) => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-native-observer-'));
  let sent = '';
  let privateHeader: string | string[] | undefined;
  const upstream = createServer(async (req, res) => {
    for await (const bytes of req) sent += String(bytes);
    privateHeader = req.headers['x-webdcc-native-session'];
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: header-se');
    setTimeout(() => res.end('cret\n\n'), 10);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test address');
  const child = fork(join(import.meta.dirname, 'fixtures/native-recorder.ts'), [`http://127.0.0.1:${address.port}/responses`], { execArgv: ['--import', 'tsx'], env: { ...process.env, WDCC_TRACE_DIR: root, WDCC_TRACE_MAX_CAPTURE_BYTES: String(captureBytes), WDCC_TRACE_MAX_FILE_BYTES: String(fileBytes), WDCC_TRACE_MAX_ACTIVE_CAPTURE_BYTES: String(activeBytes), WDCC_TRACE_MAX_DIRECTORY_BYTES: String(directoryBytes) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); })]);
    expect(message).toEqual({ text: 'data: header-secret\n\n' });
    await exited;
    expect(JSON.parse(sent)).toEqual({ password: 'nested-secret', prompt: 'native input unchanged' });
    expect(privateHeader).toBeUndefined();
    if (directoryBytes <= 128) {
      const marker = join(root, '.wdcc-diagnostic-quota.json');
      expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ incomplete: true, scope: 'directory' });
      expect((await stat(marker)).size).toBeLessThanOrEqual(4096);
      expect((await readdir(root)).filter(name => name.endsWith('.jsonl'))).toEqual([]);
      return;
    }
    if (fileBytes === 64) {
      expect(JSON.parse(await readFile(join(root, 'model-native-fixture.coverage.json'), 'utf8'))).toMatchObject({ incomplete: true });
      return;
    }
    const rows = (await readFile(join(root, 'model-native-fixture.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const body = Buffer.from(rows.find(row => row.channel === 'request').value.body, 'base64').toString();
    expect(body).not.toContain('nested-secret');
    if (captureBytes === 10000 && activeBytes !== 0) expect(JSON.parse(body).prompt).toBe('native input unchanged');
    else expect(body).toBe('');
    const terminal = rows.find(row => row.channel === 'complete').value.value;
    expect(Buffer.concat(terminal.chunks.map((chunk: { data: string }) => Buffer.from(chunk.data, 'base64'))).toString()).not.toContain('header-secret');
    expect(terminal.coverage).toMatchObject({ truncated: captureBytes === 8 || activeBytes === 0, digestScope: 'redacted' });
    if (activeBytes === 0) expect(terminal.coverage).toMatchObject({ requestLimitReason: 'active-buffer-budget', responseLimitReason: 'active-buffer-budget' });
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it('NP-14 a preload with recording disabled preserves the original fetch and native headers even with zero capture budget', async () => {
  let marker: string | string[] | undefined;
  const upstream = createServer((req, res) => { marker = req.headers['x-webdcc-native-session']; res.end('original'); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('Missing address');
  const child = fork(join(import.meta.dirname, 'fixtures/native-recorder-off.ts'), [`http://127.0.0.1:${address.port}/responses`], { execArgv: ['--import', 'tsx'], env: { ...process.env, WDCC_TRACE_DIR: undefined, WDCC_TRACE_MAX_ACTIVE_CAPTURE_BYTES: '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); })]);
    expect(message).toEqual({ unchanged: true, text: 'original' }); expect(marker).toBe('untouched');
    await exited; expect(child.exitCode).toBe(0);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

it('NP-14 native preload shares its pool across concurrent responses and module copies, then recovers after cancellation, no body and failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-native-budget-'));
  const upstream = createServer(async (req, res) => {
    if (req.url?.endsWith('?upload-failure')) { req.once('data', () => req.socket.destroy()); return; }
    for await (const _bytes of req) { /* consume the unchanged native request */ }
    if (req.url?.endsWith('?held') || req.url?.endsWith('?signal')) res.write('123456');
    else if (req.url?.endsWith('?no-body')) { res.writeHead(204); res.end(); }
    else if (req.url?.endsWith('?failure')) req.socket.destroy();
    else if (req.url?.endsWith('?stream-failure')) { res.write('abc'); setTimeout(() => res.destroy(), 10); }
    else res.end('abcdef');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('Missing address');
  const child = fork(join(import.meta.dirname, 'fixtures/native-capture-budget.ts'), [`http://127.0.0.1:${address.port}/responses`], { execArgv: ['--import', 'tsx'], env: { ...process.env, WDCC_TRACE_DIR: root, WDCC_TRACE_MAX_ACTIVE_CAPTURE_BYTES: '6' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); })]);
    expect(message).toEqual({ firstText: '123456', secondText: 'abcdef', thirdText: 'abcdef', noBodyStatus: 204, failed: true, partialFailed: true, pendingUploadFailed: true, retained: [6, 6, 0, 0, 0, 0, 0, 0, 6, 0], moduleCopyReason: 'active-buffer-budget' });
    await exited; expect(child.exitCode).toBe(0);
    const rows = (await readFile(join(root, 'model-unassigned.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const terminal = rows.filter(row => row.channel === 'complete').map(row => row.value.value);
    expect(terminal).toHaveLength(8);
    expect(terminal.filter(row => row.outcome === 'cancelled')).toHaveLength(2);
    expect(terminal.filter(row => row.outcome === 'failed')).toHaveLength(3);
    expect(terminal.find(row => row.coverage.requestLimitReason === 'capture-failed')).toMatchObject({ outcome: 'failed', coverage: { truncated: true, requestBytes: 1 } });
    expect(terminal.filter(row => row.coverage.responseLimitReason === 'active-buffer-budget')).toHaveLength(1);
    const recovered = terminal.find(row => row.outcome === 'completed' && row.coverage.responseBytes === 6 && !row.coverage.truncated);
    expect(Buffer.concat(recovered.chunks.map((chunk: { data: string }) => Buffer.from(chunk.data, 'base64'))).toString()).toBe('abcdef');
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

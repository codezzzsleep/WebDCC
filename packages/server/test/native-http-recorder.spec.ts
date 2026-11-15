import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.each([{ captureBytes: 10000, fileBytes: 1000000 }, { captureBytes: 8, fileBytes: 1000000 }, { captureBytes: 10000, fileBytes: 64 }])('NP-14 native preload preserves transport with capture/file limits $captureBytes/$fileBytes', async ({ captureBytes, fileBytes }) => {
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
  const child = fork(join(import.meta.dirname, 'fixtures/native-recorder.ts'), [`http://127.0.0.1:${address.port}/responses`], { execArgv: ['--import', 'tsx'], env: { ...process.env, WDCC_TRACE_DIR: root, WDCC_TRACE_MAX_CAPTURE_BYTES: String(captureBytes), WDCC_TRACE_MAX_FILE_BYTES: String(fileBytes) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); })]);
    expect(message).toEqual({ text: 'data: header-secret\n\n' });
    await exited;
    expect(JSON.parse(sent)).toEqual({ password: 'nested-secret', prompt: 'native input unchanged' });
    expect(privateHeader).toBeUndefined();
    if (fileBytes === 64) {
      expect(JSON.parse(await readFile(join(root, 'model-native-fixture.coverage.json'), 'utf8'))).toMatchObject({ incomplete: true });
      return;
    }
    const rows = (await readFile(join(root, 'model-native-fixture.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const body = Buffer.from(rows.find(row => row.channel === 'request').value.body, 'base64').toString();
    expect(body).not.toContain('nested-secret');
    if (captureBytes === 10000) expect(JSON.parse(body).prompt).toBe('native input unchanged');
    else expect(body).toBe('');
    const terminal = rows.find(row => row.channel === 'complete').value.value;
    expect(Buffer.concat(terminal.chunks.map((chunk: { data: string }) => Buffer.from(chunk.data, 'base64'))).toString()).not.toContain('header-secret');
    expect(terminal.coverage).toMatchObject({ truncated: captureBytes === 8, digestScope: 'redacted' });
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { InteractionRecorder } from '../src/interaction-recorder.js';
import { createTestApp, seedWorkspaceAndSession, TEST_TOKEN } from './helpers.js';

const row = { version: 1, runId: 'fixture', seq: 1, at: '2026-11-16T08:00:00Z', elapsedMs: 0, source: 'web', channel: 'fixture', value: {} };

it.each(['recording', 'coverage'])('NP-14 a %s FIFO fails recording reads without waiting for a writer', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-read-fifo-')); const recorder = new InteractionRecorder(root); await recorder.init();
  const recording = join(recorder.directory, 's.jsonl');
  if (kind === 'coverage') await writeFile(recording, JSON.stringify(row)+'\n');
  const file = kind === 'recording' ? recording : join(recorder.directory, 'coverage-s.json');
  expect(spawnSync('mkfifo', [file]).status).toBe(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = kind === 'recording' ? recorder.read('s').then(value => ({ value }), error => ({ error })) : recorder.summary('s').then(value => ({ value }), error => ({ error }));
  try {
    const before = await Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); })]);
    // Preserve the former behavior and release only this fixture if the old
    // reader waits; a fixed reader has no FIFO partner to be supplied.
    if (before === undefined) await writeFile(file, kind === 'recording' ? JSON.stringify(row)+'\n' : JSON.stringify({ incomplete: true, errors: ['controlled'] }));
    await work;
    expect(before).toBeDefined();
    if (kind === 'recording') expect(before).toMatchObject({ error: { statusCode: 503 } });
    else expect(before).toMatchObject({ value: { incomplete: true, errors: [expect.stringContaining('read')] } });
  } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
});

it('NP-14 existing recording data above the current file limit is explicit and never returned as a complete export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-read-size-')); const recorder = new InteractionRecorder(root, { maxFileBytes: 32 }); await recorder.init();
  const file = join(recorder.directory, 's.jsonl'); const content = JSON.stringify(row)+'\n'; await writeFile(file, content);
  try { await expect(recorder.read('s')).rejects.toMatchObject({ statusCode: 503 }); expect(await recorder.summary('s')).toMatchObject({ incomplete: true }); }
  finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['invalid', 'oversized', 'symlink'])('NP-14 %s coverage cannot be silently counted as complete', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-read-coverage-')); const recorder = new InteractionRecorder(root); await recorder.init();
  const file = join(recorder.directory, 'coverage-s.json');
  try {
    await writeFile(join(recorder.directory, 's.jsonl'), JSON.stringify(row)+'\n');
    if (kind === 'invalid') await writeFile(file, '{}');
    if (kind === 'oversized') await writeFile(file, ' '.repeat(64 * 1024 + 1));
    if (kind === 'symlink') { const target = join(root, 'outside.json'); await writeFile(target, JSON.stringify({ incomplete: false, errors: [] })); await symlink(target, file); }
    expect(await recorder.summary('s')).toMatchObject({ records: 1, incomplete: true, errors: [expect.stringContaining('coverage read failed')] });
    expect(await recorder.read('s')).toBe(JSON.stringify(row)+'\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('NP-14 optional missing files and normal recorded rows remain readable without changing stored evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-read-normal-')); const recorder = new InteractionRecorder(root); await recorder.init();
  const content = JSON.stringify(row)+'\n'; const file = join(recorder.directory, 's.jsonl');
  try {
    expect(await recorder.read('new')).toBe(''); expect(await recorder.summary('new')).toMatchObject({ records: 0, incomplete: false });
    await writeFile(file, content); expect(await recorder.read('s', 'missing-native', 'missing-workspace')).toBe(content);
    expect(await recorder.summary('s')).toMatchObject({ records: 1, incomplete: false }); expect(await readFile(file, 'utf8')).toBe(content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('NP-14 actual trace HTTP routes return explicit download failure and incomplete summaries for a rejected recording file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-read-http-')); const recorder = new InteractionRecorder(root); await recorder.init();
  const ctx = await createTestApp({}, TEST_TOKEN, {}, { recorder });
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    expect(spawnSync('mkfifo', [join(recorder.directory, `${encodeURIComponent(sessionId)}.jsonl`)]).status).toBe(0);
    const downloaded = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/trace?format=jsonl`, headers: { cookie: ctx.cookie } });
    expect(downloaded.statusCode).toBe(503); expect(downloaded.json().error).toBe('Diagnostic recording read failed');
    expect(downloaded.headers['content-type']).toContain('application/json'); expect(downloaded.headers['content-disposition']).toBeUndefined();
    const summary = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/trace`, headers: { cookie: ctx.cookie } });
    expect(summary.statusCode).toBe(200); expect(summary.json()).toMatchObject({ incomplete: true, errors: [expect.stringContaining('read failed')] });
    const file = join(recorder.directory, `${encodeURIComponent(sessionId)}.jsonl`); await rm(file); await writeFile(file, JSON.stringify(row)+'\n');
    const restored = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/trace?format=jsonl`, headers: { cookie: ctx.cookie } });
    expect(restored.statusCode).toBe(200); expect(restored.body).toBe(JSON.stringify(row)+'\n');
    expect(restored.headers['content-type']).toContain('application/x-ndjson'); expect(restored.headers['content-disposition']).toContain(`${sessionId}-trace.jsonl`);
    const healthy = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/trace`, headers: { cookie: ctx.cookie } });
    expect(healthy.json()).toMatchObject({ records: 1, incomplete: false });
  } finally { await ctx.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(['native', 'workspace', 'host'])('NP-14 the %s recording path has the same ordinary-file boundary', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-read-associated-')); const recorder = new InteractionRecorder(root); await recorder.init();
  const file = join(recorder.directory, kind === 'native' ? 'model-native.jsonl' : kind === 'workspace' ? 'workspace-w.jsonl' : 'dsh-host.jsonl');
  const source = kind === 'host' ? { ...row, source: 'native', context: { sessionId: 's', agent: 'dsh', workspaceId: 'w', cwd: root } } : row;
  try {
    await writeFile(join(recorder.directory, 's.jsonl'), JSON.stringify(source)+'\n'); expect(spawnSync('mkfifo', [file]).status).toBe(0);
    await expect(recorder.read('s', kind === 'native' ? 'native' : undefined, kind === 'workspace' ? 'w' : undefined)).rejects.toMatchObject({ statusCode: 503 });
    expect(await recorder.summary('s', kind === 'native' ? 'native' : undefined, kind === 'workspace' ? 'w' : undefined)).toMatchObject({ incomplete: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

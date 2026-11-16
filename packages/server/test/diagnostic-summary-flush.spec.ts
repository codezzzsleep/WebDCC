import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { InteractionRecorder } from '../src/interaction-recorder.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it.each([false, true])('first HTTP summary preserves pending write failure when corruptRead=%s', async corruptRead => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-summary-flush-'));
  const recorder = new InteractionRecorder(root); await recorder.init();
  const ctx = await createTestApp({}, undefined, {}, { recorder });
  const { sessionId } = await seedWorkspaceAndSession(ctx);
  const file = join(root, 'traces', `${sessionId}.jsonl`);
  if (corruptRead) await writeFile(file, 'invalid JSON\n');
  const lock = join(root, 'traces', '.wdcc-diagnostic-writer.lock');
  const owner = spawn('flock', ['-x', lock, process.execPath, '-e', "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(owner, 'close');
  try {
    await once(owner.stdout, 'data');
    recorder.record(sessionId, 'native', 'frame', { text: 'omitted while writer lock is held' });
    const response = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/trace`, headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ records: 0, incomplete: true, errors: expect.arrayContaining(['Diagnostic file lock helper exited']) });
    if (corruptRead) expect(response.json().errors).toContain('Diagnostic recording read failed; counters are incomplete');
    owner.stdin.end(); await closed;
    if (corruptRead) await rm(file);
    recorder.record(sessionId, 'native', 'frame', { text: 'recording recovered' });
    const recovered = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/trace`, headers: { cookie: ctx.cookie } });
    expect(recovered.json()).toMatchObject({ records: 1, nativeFrames: 1, incomplete: true, errors: expect.arrayContaining(['Diagnostic file lock helper exited']) });
    expect(await recorder.read(sessionId)).toContain('recording recovered');
  } finally {
    owner.stdin.end(); await closed;
    await recorder.flush(); await ctx.close();
    await rm(root, { recursive: true, force: true });
  }
});

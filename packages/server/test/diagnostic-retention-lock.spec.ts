import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { InteractionRecorder } from '../src/interaction-recorder.js';

it('retention respects an actual writer lock and preserves the record refreshed before that lock releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-retention-lock-'));
  const directory = join(root, 'traces');
  await mkdir(directory);
  const file = join(directory, 'active.jsonl');
  const lock = join(directory, '.wdcc-diagnostic-writer.lock');
  await writeFile(file, 'expired record');
  const old = new Date(Date.now() - 10_000);
  await utimes(file, old, old);
  await writeFile(lock, '');
  const writer = spawn('flock', ['-x', lock, process.execPath, '-e', `
    const fs = require('node:fs');
    process.stdout.write('locked\\n');
    process.stdin.once('data', () => {
      fs.writeFileSync(process.argv[1], 'fresh record');
      process.stdout.write('written\\n');
    });
    process.stdin.on('end', () => process.exit(0));
  `, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(writer, 'close');
  let cleanup: Promise<void> | undefined;
  try {
    expect(String((await once(writer.stdout, 'data'))[0])).toBe('locked\n');
    let complete = false;
    const recorder = new InteractionRecorder(root, { retentionMs: 1000 });
    cleanup = recorder.init().then(() => { complete = true; });
    await setTimeout(100);
    expect(await readFile(file, 'utf8')).toBe('expired record');
    expect(complete).toBe(false);
    const written = once(writer.stdout, 'data');
    writer.stdin.write('write');
    expect(String((await written)[0])).toBe('written\n');
    writer.stdin.end();
    await closed;
    await cleanup;
    expect(await readFile(file, 'utf8')).toBe('fresh record');
  } finally {
    writer.stdin.end();
    await closed;
    await cleanup;
    await rm(root, { recursive: true, force: true });
  }
});

it('reports bounded cleanup lock failure and retries successfully after the owner releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-retention-lock-failure-'));
  const directory = join(root, 'traces');
  await mkdir(directory);
  const lock = join(directory, '.wdcc-diagnostic-writer.lock');
  await writeFile(lock, '');
  const owner = spawn('flock', ['-x', lock, process.execPath, '-e', "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(owner, 'close');
  try {
    expect(String((await once(owner.stdout, 'data'))[0])).toBe('locked\n');
    const recorder = new InteractionRecorder(root);
    const start = Date.now();
    await expect(recorder.init()).rejects.toThrow('Diagnostic file lock helper exited');
    expect(Date.now() - start).toBeLessThan(5000);
    owner.stdin.end(); await closed;
    await recorder.init();
    recorder.record('s', 'native', 'frame', { text: 'recovered recording' });
    await recorder.flush();
    expect(await recorder.read('s')).toContain('recovered recording');
  } finally {
    owner.stdin.end(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});

it('marks activity-triggered cleanup failure incomplete without rejecting the record or summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-retention-activity-failure-'));
  const recorder = new InteractionRecorder(root);
  await recorder.init();
  const lock = join(root, 'traces', '.wdcc-diagnostic-writer.lock');
  const owner = spawn('flock', ['-x', lock, process.execPath, '-e', "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(owner, 'close');
  try {
    await once(owner.stdout, 'data');
    // Advance only the recorder's maintenance deadline; no native inputs or
    // transport clocks are changed by this scheduling fixture.
    Object.assign(recorder, { nextPruneAt: 0 });
    expect(() => recorder.record('s', 'native', 'frame', { text: 'omitted while locked' })).not.toThrow();
    const start = Date.now();
    expect(await recorder.summary('s')).toMatchObject({ incomplete: true, errors: expect.arrayContaining(['Diagnostic retention cleanup failed']) });
    expect(Date.now() - start).toBeLessThan(5000);
    owner.stdin.end(); await closed;
    recorder.record('s', 'native', 'frame', { text: 'recording recovered' });
    expect(await recorder.read('s')).toContain('recording recovered');
    expect((await recorder.summary('s')).incomplete).toBe(true);
  } finally {
    owner.stdin.end(); await closed;
    await recorder.flush();
    await rm(root, { recursive: true, force: true });
  }
});

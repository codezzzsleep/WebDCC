import { mkdtemp, writeFile, readFile, rm, symlink, readdir, open, appendFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { readDiagnosticText } from './diagnostic-reader.js';

it('bounded diagnostic reads preserve UTF-8 bytes at the exact limit and leave source files intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-reader-limit-')); const file = join(root, 'record.jsonl');
  const text = '原始 record 🧪\n';
  try {
    await writeFile(file, text); const bytes = await readFile(file);
    expect(await readDiagnosticText(file, bytes.length)).toBe(text);
    await expect(readDiagnosticText(file, bytes.length - 1)).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(file)).toEqual(bytes);
    await writeFile(file, ''); expect(await readDiagnosticText(file, 0)).toBe('');
    expect(await readDiagnosticText(join(root, 'missing'), 10, true)).toBeUndefined();
    await expect(readDiagnosticText(join(root, 'missing'), 10)).rejects.toMatchObject({ statusCode: 503 });
    await writeFile(file, Buffer.from([255])); await expect(readDiagnosticText(file, 10)).rejects.toMatchObject({ statusCode: 503 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('diagnostic byte limits still apply when a regular file grows after its descriptor size check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-reader-growth-')); const file = join(root, 'record.jsonl');
  await writeFile(file, '{}'); const control = await open(file, 'r');
  const actualStat = control.stat.bind(control);
  const prototype = Object.getPrototypeOf(control) as { stat: () => Promise<Stats> };
  const spy = vi.spyOn(prototype, 'stat').mockImplementation(async () => {
    const observed = await actualStat(); await appendFile(file, 'x'.repeat(64)); return observed;
  });
  try {
    await expect(readDiagnosticText(file, 32)).rejects.toMatchObject({ statusCode: 503, reason: 'too-large' });
    expect((await readFile(file)).length).toBe(66);
  } finally { spy.mockRestore(); await control.close(); await rm(root, { recursive: true, force: true }); }
});

it('diagnostic readers reject FIFO, final symlink, directory and device without retaining descriptors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-reader-types-')); const file = join(root, 'record.jsonl'); const link = join(root, 'link.jsonl'); const fifo = join(root, 'fifo.jsonl');
  try {
    await writeFile(file, '{}\n'); await symlink(file, link); expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const before = (await readdir('/proc/self/fd')).length;
    for (let i = 0; i < 20; i++) {
      expect(await readDiagnosticText(file, 100)).toBe('{}\n');
      for (const path of [link, fifo, root, '/dev/null']) await expect(readDiagnosticText(path, 100)).rejects.toMatchObject({ statusCode: 503 });
    }
    expect((await readdir('/proc/self/fd')).length).toBe(before);
    expect(await readFile(file, 'utf8')).toBe('{}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

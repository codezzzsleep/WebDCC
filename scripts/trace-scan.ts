import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function collect(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return [];
  if (info.isFile()) return [path];
  return (await Promise.all((await readdir(path, { withFileTypes: true })).map((entry) => collect(join(path, entry.name))))).flat();
}
const paths = await collect('fixtures/traces');
let text = '';
for (const path of paths) text += await readFile(path, 'utf8');
try { text += execFileSync('git', ['diff', '--cached', '--binary'], { encoding: 'utf8' }); } catch { /* no index */ }
const patterns = [
  /\bsk-(?!<redacted)[A-Za-z0-9_-]{8,}\b/gi,
  /\bBearer\s+(?!<redacted)[A-Za-z0-9._-]+/gi,
  /[?&]token=(?!<redacted)[^&\s"']+/gi,
  /https?:\/\/(?!provider\.example)[^/\s"']+/gi,
];
let hits = 0;
for (const pattern of patterns) hits += [...text.matchAll(pattern)].length;
process.stdout.write(`trace:scan hits=${hits}\n`);
if (hits > 0) process.exitCode = 1;

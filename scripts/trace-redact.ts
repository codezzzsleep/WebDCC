import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (root === undefined) throw new Error('用法：pnpm trace:redact <trace-dir>');

async function files(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => files(join(path, entry.name))))).flat();
}

function redactText(input: string): string {
  return input
    .replace(/("encrypted_content"\s*:\s*")(.*?)(")/gi, (_match, prefix: string, value: string, suffix: string) => `${prefix}<redacted:${Buffer.byteLength(value, 'utf8')} bytes>${suffix}`)
    .replace(/(authorization\s*[:=]\s*["']?)([^\s,"'}]+)/gi, '$1<redacted>')
    .replace(/(x-api-key\s*[:=]\s*["']?)([^\s,"'}]+)/gi, '$1<redacted>')
    .replace(/(cookie|set-cookie)\s*[:=]\s*["']?([^\n"']+)/gi, '$1: <redacted>')
    .replace(/([?&]token=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '<redacted:key>')
    .replace(/https?:\/\/([^/\s"']+)/g, 'https://provider.example')
    .replace(/\/root\/[A-Za-z0-9._-]+/g, '~')
    .replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '<redacted:account>');
}

for (const file of await files(root)) {
  const text = await readFile(file, 'utf8');
  await writeFile(file, redactText(text));
}

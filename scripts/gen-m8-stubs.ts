/**
 * 生成 `e2e-real/stubs.spec.ts`：第 7 节里还没有实现体的用例 ID，
 * 一律落成显式失败的占位用例（`throw new Error('NOT IMPLEMENTED: <ID>')`），
 * 这算失败，不算跳过（SPEC-M8 0.1 Q9 / 第 8 节棘轮规则）。
 *
 * 用法：pnpm tsx scripts/gen-m8-stubs.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function expand(id: string): string[] {
  const match = /\{([^}]+)\}/.exec(id);
  if (match?.[1] === undefined) return [id];
  const options = match[1].split(',');
  return options.flatMap((option) => expand(id.replace(`{${match[1]}}`, option.trim())));
}

export function specIds(specPath = 'docs/specs/SPEC-M8.md'): string[] {
  const lines = readFileSync(specPath, 'utf8').split('\n');
  const ids = new Set<string>();
  let inSection7 = false;
  for (const line of lines) {
    if (line.startsWith('## 7.')) inSection7 = true;
    else if (line.startsWith('## 8.')) inSection7 = false;
    if (!inSection7 || !line.startsWith('| ')) continue;
    const first = line.trim().replace(/^\|/, '').split('|')[0]?.trim() ?? '';
    const raw = first.replace(/`/g, '');
    if (raw === 'ID' || raw === '') continue;
    if (!/^[A-Z][A-Z0-9-]*/.test(raw)) continue;
    for (const id of expand(raw)) ids.add(id);
  }
  return [...ids].sort();
}

/** 已在 spec 文件里出现过的用例 ID（标题以 ID 开头） */
export function implementedIds(dir = 'e2e-real'): Set<string> {
  // 注意：stubs.spec.ts 里出现的 ID 不算"已实现"（它本身就是占位）
  const ids = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.spec.ts') || file === 'stubs.spec.ts') continue;
    const text = readFileSync(join(dir, file), 'utf8');
    for (const match of text.matchAll(/test(?:\.each\([^)]*\))?\(\s*[`'"]([A-Z][A-Za-z0-9-]*)/g)) {
      const id = match[1];
      if (id !== undefined) ids.add(id);
    }
    // 模板写法：`AG-${agent}-01 ...`
    for (const match of text.matchAll(/test\(\s*`([^`]+)`/g)) {
      const raw = match[1] ?? '';
      for (const agent of ['dsh', 'codex', 'claude']) {
        const candidate = raw.replace('${agent}', agent);
        const id = /^([A-Z][A-Za-z0-9-]*)/.exec(candidate)?.[1];
        if (id !== undefined && !id.includes('$')) ids.add(id);
      }
    }
  }
  return ids;
}

function main(): void {
  const expected = specIds();
  const done = implementedIds();
  const missing = expected.filter((id) => !done.has(id));
  const body = missing
    .map(
      (id) => `  test('${id} 未实现（占位，SPEC 第 7 节）', () => {
    throw new Error('NOT IMPLEMENTED: ${id}');
  });`,
    )
    .join('\n\n');
  const content = `/**
 * 自动生成，不要手改：scripts/gen-m8-stubs.ts
 * 第 7 节里还没有实现体的用例 ID 一律显式失败（SPEC-M8 0.1 Q9）。
 */
import { test } from './fixtures.js';

test.describe('未实现的用例（占位）', () => {
${body}
});
`;
  writeFileSync('e2e-real/stubs.spec.ts', content);
  process.stdout.write(`已生成 e2e-real/stubs.spec.ts：已实现 ${expected.length - missing.length}/${expected.length}，占位 ${missing.length}\n`);
}

if (process.argv[1]?.endsWith('gen-m8-stubs.ts') === true) main();

/** F12：Codex 的每个 ServerNotification 方法都必须有显式归类，unknown 只留给 schema 之外的事件 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, routeNotification } from '../src/adapter.js';

function schemaMethods(): string[] {
  const text = readFileSync(join(__dirname, '../src/schema/ServerNotification.ts'), 'utf8');
  return [...new Set([...text.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1] as string))];
}

describe('Codex 通知归类（F12）', () => {
  it('schema 里的每个方法都有显式归类', () => {
    const unknown = schemaMethods().filter((method) => routeNotification(method) === 'unknown');
    expect(unknown).toEqual([]);
  });

  it('原生界面会显示的内容不归为 internal', () => {
    for (const method of ['thread/goal/updated', 'thread/goal/cleared', 'turn/plan/updated', 'turn/diff/updated', 'warning', 'configWarning', 'deprecationNotice']) {
      expect(routeNotification(method), method).not.toBe('internal');
      expect(routeNotification(method), method).not.toBe('unknown');
    }
  });

  it('schema 之外的方法才是 unknown', () => {
    expect(routeNotification('totally/unknown/event')).toBe('unknown');
  });
});

describe('turn/diff/updated 解析（C2 第 1 级）', () => {
  it('统计每个文件的增删行数', () => {
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      'new file mode 100644',
      'index 0000000..d2c1cb5',
      '--- /dev/null',
      '+++ b/notes.txt',
      '@@ -0,0 +1,2 @@',
      '+第一行',
      '+第二行',
      'diff --git a/README.md b/README.md',
      'index 1cba9fc..67aac5d 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,4 +1,4 @@',
      ' # Sample Repo',
      '-line to modify: ORIGINAL',
      '+line to modify: UPDATED',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.map(({ path, kind, added, removed }) => ({ path, kind, added, removed }))).toEqual([
      { path: 'notes.txt', kind: 'add', added: 2, removed: 0 },
      { path: 'README.md', kind: 'modify', added: 1, removed: 1 },
    ]);
    // 每个文件的 diff 文本也要带上（停靠区的 diff 标签用它）
    expect(parsed[0]?.diff).toContain('+第一行');
    expect(parsed[1]?.diff).toContain('-line to modify: ORIGINAL');
  });
});

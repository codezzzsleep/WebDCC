/**
 * 改动条目（C2 / F10）：
 *  1) 原生提供的 diff；
 *  2) edit 类调用用 old_string / new_string 生成该处的 hunk；
 *  3) 整文件写入按新文件计算，并注明"整文件写入，未取得原内容"。
 */
import type { FileChangeEntry } from './events.js';

function countLines(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
}

function lines(text: string, prefix: '-' | '+'): string {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/** 由 write / edit 的入参算出改动条目 */
export function buildFileChanges(name: string, input: Record<string, unknown>): FileChangeEntry[] {
  const path = String(input['file_path'] ?? input['path'] ?? '');
  if (path === '') return [];
  if (name === 'write' || name === 'Write') {
    const content = String(input['content'] ?? '');
    const count = countLines(content);
    return [
      {
        path,
        kind: 'add',
        added: count,
        removed: 0,
        note: '整文件写入，未取得原内容',
        diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n${lines(content, '+')}\n`,
      },
    ];
  }
  if (name === 'edit' || name === 'Edit' || name === 'MultiEdit') {
    const before = String(input['old_string'] ?? '');
    const after = String(input['new_string'] ?? '');
    const removed = countLines(before);
    const added = countLines(after);
    return [
      {
        path,
        kind: 'modify',
        added,
        removed,
        diff: `--- a/${path}\n+++ b/${path}\n@@ -1,${removed} +1,${added} @@\n${lines(before, '-')}\n${lines(after, '+')}\n`,
      },
    ];
  }
  return [{ path, kind: 'modify', added: 0, removed: 0 }];
}

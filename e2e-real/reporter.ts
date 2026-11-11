/** 汇总报告：从 SPEC-M8 第 7 节解析用例 ID，实际执行的集合必须完全一致（SPEC-M8 6.6） */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

const SPEC = join(process.cwd(), 'docs/specs/SPEC-M8.md');
const OUT = join(process.cwd(), 'docs/acceptance/M8');

function expand(id: string): string[] {
  const match = /\{([^}]+)\}/.exec(id);
  if (match?.[1] === undefined) return [id];
  const options = match[1].split(',');
  return options.flatMap((option) => expand(id.replace(`{${match[1]}}`, option.trim())));
}

export function parseSpecIds(): string[] {
  const lines = readFileSync(SPEC, 'utf8').split('\n');
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

interface CaseResult {
  title: string;
  id: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

class M8Reporter implements Reporter {
  private readonly results: CaseResult[] = [];
  private startedAt = new Date().toISOString();

  onBegin(): void {
    this.startedAt = new Date().toISOString();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const title = test.title;
    const id = title.split(' ')[0] ?? title;
    this.results.push({
      title,
      id,
      status: result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed',
      durationMs: result.duration,
      ...(result.error?.message === undefined ? {} : { error: result.error.message.slice(0, 800) }),
    });
  }

  onEnd(): void {
    const expected = parseSpecIds();
    const executed = new Set(this.results.map((r) => r.id));
    const missing = expected.filter((id) => !executed.has(id));
    const extra = [...executed].filter((id) => !expected.includes(id));
    const failed = this.results.filter((r) => r.status !== 'passed');
    const passed = this.results.filter((r) => r.status === 'passed');
    const ok = failed.length === 0 && missing.length === 0 && extra.length === 0;
    const commit = (() => {
      try {
        const head = readFileSync(join(process.cwd(), '.git/HEAD'), 'utf8').trim();
        if (!head.startsWith('ref: ')) return head.slice(0, 12);
        const ref = head.slice(5);
        return readFileSync(join(process.cwd(), '.git', ref), 'utf8').trim().slice(0, 12);
      } catch {
        return 'unknown';
      }
    })();
    mkdirSync(OUT, { recursive: true });
    const report = {
      commit,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      expectedCount: expected.length,
      executedCount: executed.size,
      passedCount: passed.length,
      missing,
      extra,
      results: this.results,
    };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(OUT, 'status.json'), JSON.stringify(Object.fromEntries(this.results.map((r) => [r.id, r.status === 'passed'])), null, 2));
    const rows = this.results
      .map((r) => `<tr class="${r.status}"><td>${r.id}</td><td>${r.title}</td><td>${r.status}</td><td>${Math.round(r.durationMs / 1000)}s</td></tr>`)
      .join('\n');
    writeFileSync(
      join(OUT, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>M8 acceptance</title><style>body{font-family:system-ui;padding:24px}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #eee}.failed{background:#fee}.skipped{background:#ffd}</style><h1>M8 验收</h1><p>通过 ${passed.length}/${expected.length}，失败 ${failed.length}，缺少 ${missing.length}，多余 ${extra.length}</p><table><tr><th>ID</th><th>用例</th><th>结果</th><th>耗时</th></tr>${rows}</table>`,
    );
    const summary = `M8 ACCEPTANCE: ${passed.length}/${expected.length} passed ×${1} @ ${commit}`;
    process.stdout.write(`\n${summary}\n`);
    if (!ok) process.stdout.write(`未通过：${failed.map((r) => r.id).join(', ') || '无'}；缺少：${missing.join(', ') || '无'}；多余：${extra.join(', ') || '无'}\n`);
  }
}

export default M8Reporter;

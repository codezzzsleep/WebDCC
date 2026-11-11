/**
 * M8 汇总报告（SPEC-M8 6.6 / 第 8 节）。
 *
 * 每个用例的标题都以 ID 开头；实际执行的 ID 集合必须与 `docs/specs/SPEC-M8.md`
 * 第 7 节解析出的集合完全相同，并且每一个都通过，否则本报告器判失败。
 *
 * 一遍跑完写 `pass-<n>.json`；`scripts/accept-m8.ts` 在两遍都跑完后合并出
 * `report.json` / `status.json` / `index.html`。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

const SPEC = join(process.cwd(), 'docs/specs/SPEC-M8.md');
const OUT = join(process.cwd(), 'docs/acceptance/M8');
const PASS = Number(process.env['M8_PASS'] ?? '1');

export type CaseStatus = 'passed' | 'failed' | 'not-implemented';

export interface CaseResult {
  title: string;
  id: string;
  status: CaseStatus;
  durationMs: number;
  error?: string;
  shots: string[];
}

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

function commitSha(): string {
  try {
    const head = readFileSync(join(process.cwd(), '.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 12);
    return readFileSync(join(process.cwd(), '.git', head.slice(5)), 'utf8').trim().slice(0, 12);
  } catch {
    return 'unknown';
  }
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
    const message = result.error?.message ?? '';
    const status: CaseStatus = result.status === 'passed' ? 'passed' : message.includes('NOT IMPLEMENTED:') ? 'not-implemented' : 'failed';
    const shots: string[] = [];
    for (const attachment of result.attachments) {
      if (attachment.path === undefined || !existsSync(attachment.path)) continue;
      mkdirSync(join(OUT, 'shots'), { recursive: true });
      const target = join(OUT, 'shots', `${id}-${basename(attachment.path)}`);
      try {
        copyFileSync(attachment.path, target);
        shots.push(`shots/${basename(target)}`);
      } catch {
        // 截图复制失败不影响用例判定
      }
    }
    this.results.push({
      title,
      id,
      status,
      durationMs: result.duration,
      ...(message === '' ? {} : { error: message.slice(0, 800) }),
      shots,
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
    const commit = commitSha();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, `pass-${PASS}.json`),
      JSON.stringify(
        {
          commit,
          pass: PASS,
          startedAt: this.startedAt,
          finishedAt: new Date().toISOString(),
          expectedCount: expected.length,
          executedCount: executed.size,
          passedCount: passed.length,
          results: this.results,
          missing,
          extra,
        },
        null,
        2,
      ),
    );
    const summary = `M8 ACCEPTANCE: ${passed.length}/${expected.length} passed ×${PASS} @ ${commit}`;
    process.stdout.write(`\n${summary}\n`);
    if (!ok) {
      process.stdout.write(
        `未通过：${failed.map((r) => r.id).join(', ') || '无'}；缺少：${missing.join(', ') || '无'}；多余：${extra.join(', ') || '无'}\n`,
      );
    }
  }
}

export default M8Reporter;

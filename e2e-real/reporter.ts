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
import { createRunIdentity, requiredCasePredicates, type RunIdentity } from '../scripts/lib/gate-report.js';

const SPEC = join(process.cwd(), 'docs/specs/SPEC-M8.md');
const OUT = process.env['WDCC_ACCEPT_OUT'] ?? join(process.cwd(), 'docs/acceptance/M8');
const PASS = Number(process.env['M8_PASS'] ?? '1');

export type CaseStatus = 'passed' | 'failed' | 'not-implemented';

export interface CaseResult {
  title: string;
  id: string;
  status: CaseStatus;
  durationMs: number;
  error?: string;
  shots: string[];
  requiredNativePredicates?: string[];
  nativePredicates?: Record<string, boolean>;
  uiActions?: string[];
  evidence?: string[];
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

class M8Reporter implements Reporter {
  private readonly results: CaseResult[] = [];
  private startedAt = new Date().toISOString();
  private identity: RunIdentity = createRunIdentity(process.env['M8_RUN_ID']);

  onBegin(): void {
    this.startedAt = new Date().toISOString();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const title = test.title;
    const id = title.split(' ')[0] ?? title;
    const message = result.error?.message ?? '';
    const status: CaseStatus = result.status === 'passed' ? 'passed' : message.includes('NOT IMPLEMENTED:') ? 'not-implemented' : 'failed';
    const shots: string[] = [];
    let nativePredicates: Record<string, boolean> = {};
    let uiActions: string[] = [];
    const evidence: string[] = [];
    for (const attachment of result.attachments) {
      if (attachment.name === 'native-proof') {
        try {
          const text = attachment.body?.toString('utf8') ?? (attachment.path === undefined ? '' : readFileSync(attachment.path, 'utf8'));
          const proof = JSON.parse(text) as { nativePredicates: Record<string, boolean>; uiActions: string[] };
          nativePredicates = proof.nativePredicates;
          uiActions = proof.uiActions;
          evidence.push(`native-proof:${id}`);
        } catch { nativePredicates = {}; uiActions = []; }
      }
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
      requiredNativePredicates: requiredCasePredicates(id), nativePredicates, uiActions, evidence,
    });
  }

  async onEnd(): Promise<{ status: 'passed' | 'failed' }> {
    const expected = parseSpecIds();
    const executed = new Set(this.results.map((r) => r.id));
    const missing = expected.filter((id) => !executed.has(id));
    const extra = [...executed].filter((id) => !expected.includes(id));
    const failed = this.results.filter((r) => r.status !== 'passed');
    const passed = this.results.filter((r) => r.status === 'passed');
    const untriggered = this.results.filter(result => result.requiredNativePredicates?.some(predicate => result.nativePredicates?.[predicate] !== true));
    const ok = failed.length === 0 && missing.length === 0 && extra.length === 0 && executed.size === this.results.length && untriggered.length === 0;
    const commit = this.identity.commit;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, `pass-${PASS}.json`),
      JSON.stringify(
        {
          commit,
          identity: this.identity,
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
    return { status: ok ? 'passed' : 'failed' };
  }
}

export default M8Reporter;

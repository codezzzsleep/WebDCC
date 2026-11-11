/**
 * M8 验收入口（SPEC-M8 6.1 / 第 8 节）。
 *   pnpm accept:m8            严格模式：全部步骤 + 真实套件连续两遍（全新临时目录与进程）
 *   pnpm accept:m8 --ratchet  开发期：只要求"之前通过的用例不能变红"
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ratchet = process.argv.includes('--ratchet');
const OUT = join(process.cwd(), 'docs/acceptance/M8');

interface CaseResult {
  title: string;
  id: string;
  status: 'passed' | 'failed' | 'not-implemented';
  durationMs: number;
  error?: string;
  shots: string[];
}

interface PassFile {
  commit: string;
  pass: number;
  startedAt: string;
  finishedAt: string;
  expectedCount: number;
  passedCount: number;
  results: CaseResult[];
  missing: string[];
  extra: string[];
}

function run(command: string, args: string[], label: string, env: NodeJS.ProcessEnv = process.env): void {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    execFileSync(command, args, { stdio: 'inherit', env });
  } catch {
    process.stderr.write(`\n[${label}] 失败\n`);
    process.exit(1);
  }
}

function readPass(pass: number): PassFile {
  const path = join(OUT, `pass-${pass}.json`);
  if (!existsSync(path)) {
    process.stderr.write(`缺少第 ${pass} 遍的结果：${path}\n`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as PassFile;
}

function agentVersions(): Record<string, string> {
  const version = (command: string, args: string[]): string => {
    try {
      return execFileSync(command, args, { encoding: 'utf8' }).trim().split('\n')[0] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
  return {
    node: process.version,
    codex: version('codex', ['--version']),
    claude: version('claude', ['--version']),
    dsh: version('dsh', ['--version']),
  };
}

function merge(): void {
  const passes = ratchet ? [readPass(1)] : [readPass(1), readPass(2)];
  const first = passes[0];
  if (first === undefined) throw new Error('没有结果');
  const expected = first.expectedCount;
  const byId = new Map<string, CaseResult>();
  for (const pass of passes) {
    for (const result of pass.results) {
      const existing = byId.get(result.id);
      // 两遍都通过才算通过：保留最差状态
      if (existing === undefined || existing.status === 'passed') byId.set(result.id, result);
    }
  }
  const results = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const status: Record<string, 'passed' | 'failed' | 'not-implemented'> = {};
  for (const result of results) status[result.id] = result.status;
  const passedCount = results.filter((result) => result.status === 'passed').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  const notImplemented = results.filter((result) => result.status === 'not-implemented').length;

  const report = {
    commit: first.commit,
    startedAt: passes[0]?.startedAt ?? '',
    finishedAt: passes[passes.length - 1]?.finishedAt ?? '',
    node: process.version,
    agents: agentVersions(),
    expectedCount: expected,
    executedCount: results.length,
    passedCount,
    failedCount,
    notImplemented,
    passes: passes.map((pass) => ({
      pass: pass.pass,
      startedAt: pass.startedAt,
      finishedAt: pass.finishedAt,
      passedCount: pass.passedCount,
      missing: pass.missing,
      extra: pass.extra,
    })),
    missing: first.missing,
    extra: first.extra,
    results,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'status.json'), JSON.stringify(status, null, 2));

  // 截图总览（index.html）：按用例分组，标注"待用户确认"的 UI/MOB 截图
  const groups = new Map<string, CaseResult[]>();
  for (const result of results) {
    const prefix = result.id.split('-')[0] ?? result.id;
    const list = groups.get(prefix) ?? [];
    list.push(result);
    groups.set(prefix, list);
  }
  const rows = [...groups.entries()]
    .map(
      ([prefix, list]) =>
        `<h2>${prefix}</h2>` +
        list
          .map(
            (result) =>
              `<section class="${result.status}"><h3>${result.id} ${result.title.replace(/^[^ ]+ /, '')}</h3>` +
              `<p>${result.status} · ${Math.round(result.durationMs / 1000)}s</p>` +
              (result.shots.length === 0 ? '' : result.shots.map((shot) => `<a href="${shot}"><img src="${shot}" loading="lazy" /></a>`).join('')) +
              (result.error === undefined ? '' : `<pre>${result.error.slice(0, 400).replace(/</g, '&lt;')}</pre>`) +
              `</section>`,
          )
          .join(''),
    )
    .join('\n');
  writeFileSync(
    join(OUT, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>M8 验收</title>
<style>
body{font-family:system-ui;padding:24px;background:#fafafa}
section{background:#fff;border:1px solid #eee;border-radius:8px;padding:12px;margin:12px 0}
section.failed{border-color:#f99;background:#fff6f6}
section.not-implemented{background:#fffff6;border-color:#fd8}
img{max-width:420px;margin:6px;border:1px solid #ddd;border-radius:4px}
h2{margin-top:32px}
pre{white-space:pre-wrap;color:#a00;font-size:12px}
</style>
<h1>M8 验收 · ${passedCount}/${expected} 通过（${passes.length} 遍）</h1>
<p>commit ${first.commit} · 失败 ${failedCount} · 未实现 ${notImplemented}</p>
<p>UI-01 / MOB-03 的截图供用户确认（SPEC 1.1）。</p>
${rows}`,
  );

  const summary = `M8 ACCEPTANCE: ${passedCount}/${expected} passed ×${passes.length} @ ${first.commit}`;
  process.stdout.write(`\n${summary}\n`);

  // 报告体积上限 40 MB（SPEC 6.6）
  const size = directorySize(OUT);
  if (size > 40 * 1024 * 1024) process.stderr.write(`警告：docs/acceptance/M8 大小 ${Math.round(size / 1024 / 1024)}MB 超过 40MB\n`);

  if (ratchet) {
    let baseline: Record<string, string> = {};
    try {
      baseline = JSON.parse(execFileSync('git', ['show', 'origin/main:docs/acceptance/M8/status.json'], { encoding: 'utf8' })) as Record<string, string>;
    } catch {
      baseline = {};
    }
    const regressions = Object.entries(baseline)
      .filter(([id, value]) => value === 'passed' && status[id] !== 'passed')
      .map(([id]) => id);
    const implementedNow = results.filter((result) => result.status !== 'not-implemented').map((result) => result.id);
    const regressionsImplemented = Object.entries(baseline)
      .filter(([id, value]) => value !== 'not-implemented' && !implementedNow.includes(id))
      .map(([id]) => id);
    if (regressions.length > 0 || regressionsImplemented.length > 0) {
      process.stderr.write(`棘轮失败：变红 ${regressions.join(', ') || '无'}；实现集合减少 ${regressionsImplemented.join(', ') || '无'}\n`);
      process.exit(1);
    }
    const newlyPassed = results.filter((result) => result.status === 'passed' && baseline[result.id] !== 'passed').map((result) => result.id);
    process.stdout.write(`棘轮通过。本次由失败变通过：${newlyPassed.join(', ') || '无'}\n`);
    return;
  }

  if (failedCount > 0 || notImplemented > 0 || first.missing.length > 0 || first.extra.length > 0 || passes.length !== 2) {
    process.stderr.write(`\n严格模式失败：通过 ${passedCount}/${expected}\n`);
    process.exit(1);
  }
}

function directorySize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else total += statSync(full).size;
  }
  return total;
}

void copyFileSync;

run('pnpm', ['typecheck'], 'typecheck');
run('pnpm', ['lint'], 'lint');
run('npx', ['vitest', 'run'], 'unit tests');
run('npx', ['playwright', 'test', 'e2e/', '--reporter=list'], 'fake-adapter e2e');
run('pnpm', ['build'], 'build');

const passes = ratchet ? 1 : 2;
for (let pass = 1; pass <= passes; pass += 1) {
  run('npx', ['playwright', 'test', '-c', 'playwright.real.config.ts'], `real acceptance pass ${pass}/${passes}`, {
    ...process.env,
    M8_PASS: String(pass),
  });
}

merge();

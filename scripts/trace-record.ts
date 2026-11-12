import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith('--') && value !== undefined && !value.startsWith('--')) args.set(key.slice(2), value);
}
const agent = args.get('agent');
const scenario = args.get('scenario');
if (agent === undefined || !['codex', 'claude-code', 'dsh'].includes(agent) || scenario === undefined) {
  throw new Error('用法：pnpm trace:record --agent <codex|claude-code|dsh> --scenario <id|all> [--model <slug>]');
}
const scenarios: Record<string, string> = {
  S01: '用一句话解释什么是幂等。不要使用任何工具。',
  S02: '先列出当前目录的文件，再读 README.md，然后用三句话告诉我这个仓库是做什么的。',
  S03: '新建 notes.txt，内容两行：第一行 alpha，第二行 beta。然后把 README.md 的标题改成 "Sample Repo (edited)"。做完后告诉我改了什么。',
  S04: '在 /tmp 下创建文件 wdcc-trace-probe.txt，内容为 ok。',
  S05: '在 /tmp 下创建文件 wdcc-trace-probe-2.txt，内容为 ok。',
  S06: '运行 sleep 60，然后告诉我完成了。',
  S07: '这个任务分三步做，先给出计划再执行：1) 新建 a.txt 写入 1；2) 新建 b.txt 写入 2；3) 把两个数相加写入 sum.txt。',
  S08: '在动手之前，先用提问工具问我想用哪种语言写 hello world（给出 Python 和 JavaScript 两个选项），等我回答后再写。',
  S09: '运行命令 false-command-wdcc（它不存在），把报错原样告诉我，不要重试。',
  S10: '读取 README.md 的第一行。',
  S11: '运行 seq 1 3000，然后只告诉我最后一个数字。',
};
if (scenario !== 'all' && scenarios[scenario] === undefined) throw new Error(`未知场景：${scenario}`);
const runId = `${Date.now().toString(36)}-${process.pid}`;
const outputRoot = join(tmpdir(), `wdcc-trace-${runId}`);
const ids = scenario === 'all' ? Object.keys(scenarios) : [scenario];
const fixtureModel = args.get('model') ?? 'default';
const fixtureRoot = join(process.cwd(), 'fixtures', 'traces', agent, fixtureModel);
await mkdir(fixtureRoot, { recursive: true });
const failures: { scenario: string; reason: string }[] = [];
for (const id of ids) {
  const raw = join(outputRoot, id);
  await mkdir(raw, { recursive: true });
  try {
    execFileSync('pnpm', ['tsx', 'packages/server/src/trace-real.ts', '--agent', agent, '--scenario', id, '--out', raw, ...(args.get('model') === undefined ? [] : ['--model', args.get('model') as string])], { cwd: process.cwd(), stdio: 'inherit' });
    const target = join(fixtureRoot, id);
    await mkdir(target, { recursive: true });
    await cp(raw, target, { recursive: true });
    execFileSync('pnpm', ['trace:redact', target], { cwd: process.cwd(), stdio: 'inherit' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({ scenario: id, reason });
    const target = join(fixtureRoot, id);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'meta.json'), JSON.stringify({ version: 1, agent, scenario: id, model: args.get('model') ?? null, prompt: scenarios[id], recordedAt: new Date().toISOString(), notTriggered: [reason] }, null, 2) + '\n');
  }
}
await writeFile(join(outputRoot, 'run.json'), JSON.stringify({ agent, scenarios: ids, failures, finishedAt: new Date().toISOString() }, null, 2) + '\n');
process.stdout.write(`${outputRoot}\n`);
if (failures.length > 0 && ids.length === 1) process.exitCode = 1;

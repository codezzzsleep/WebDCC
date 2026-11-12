import Database from 'better-sqlite3';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, TraceFrame, TraceSink } from '@webdcc/protocol';
import { CodexAdapter } from '@webdcc/adapter-codex';
import { ClaudeAdapter } from '@webdcc/adapter-claude';
import { DshAdapter } from '@webdcc/adapter-dsh';
import { Store } from './store.js';
import { ProviderRegistry } from './providers.js';
import { ModelProxy } from '../../testing/model-proxy/src/index.js';

const scenarioPrompts: Record<string, string> = {
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

interface Args { agent: 'codex' | 'claude-code' | 'dsh'; scenario: string; model?: string; out: string; }

function parseArgs(): Args {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (key?.startsWith('--') && value !== undefined && !value.startsWith('--')) values.set(key.slice(2), value);
  }
  const agent = values.get('agent');
  const scenario = values.get('scenario');
  const out = values.get('out');
  if ((agent !== 'codex' && agent !== 'claude-code' && agent !== 'dsh') || scenario === undefined || out === undefined) {
    throw new Error('trace-real 用法：--agent codex|claude-code|dsh --scenario S01 --out <dir> [--model <slug>]');
  }
  if (scenarioPrompts[scenario] === undefined) throw new Error(`未知场景：${scenario}`);
  return { agent, scenario, out, ...(values.get('model') === undefined ? {} : { model: values.get('model') }) };
}

class JsonlSink implements TraceSink {
  private index = 0;
  private readonly started = Date.now();
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  record(frame: TraceFrame): void {
    const value = { i: ++this.index, t: Date.now() - this.started, dir: frame.dir, ch: frame.ch, frame: redact(frame.frame) };
    this.pending = this.pending.then(() => appendFile(this.file, `${JSON.stringify(value)}\n`));
  }
  async flush(): Promise<void> { await this.pending; }
}

function redact(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (/(authorization|api[_-]?key|token|cookie|secret|password|bearer)/i.test(key)) return '<redacted>';
    return value
      .replace(/\bBearer\s+[^\s]+/gi, 'Bearer <redacted>')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted:key>')
      .replace(/https?:\/\/[^/\s]+/g, 'https://provider.example')
      .replace(/\/root\//g, '~/')
      .replace(/\/home\/[A-Za-z0-9._-]+/g, '~/');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) result[childKey] = redact(child, childKey);
    return result;
  }
  return value;
}

async function providerConfig(agent: Args['agent']): Promise<{ id: string; models: string[]; config: NonNullable<ReturnType<ProviderRegistry['runtimeConfig']>> }> {
  const dataDir = join(homedir(), '.webdcc');
  const db = new Database(join(dataDir, 'webdcc.db'), { readonly: true, fileMustExist: true });
  try {
    const store = new Store(db);
    const registry = new ProviderRegistry(store, dataDir);
    await registry.init();
    const protocol = agent === 'codex' ? 'openai-responses' : agent === 'claude-code' ? 'anthropic-messages' : undefined;
    if (protocol === undefined) throw new Error('DSH 的真实 Provider 需要通过临时 DSH 实例配置，先跳过模型层');
    const row = store.listProviders().find((candidate) => candidate.protocols.includes(protocol));
    if (row === undefined) throw new Error(`没有 ${protocol} Provider`);
    const config = registry.runtimeConfig(row.id);
    if (config === null || config.apiKey === undefined || config.apiKey === '') throw new Error(`Provider ${row.id} 没有可用 Key`);
    return { id: row.id, models: row.models, config };
  } finally {
    db.close();
  }
}

async function sampleRepo(root: string): Promise<string> {
  const repo = join(root, 'sample-repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'README.md'), '# Sample Repo\n\nWebDCC trace sample.\n');
  await writeFile(join(repo, 'SPEC.md'), '# Spec\n\nTrace sample workspace.\n');
  await writeFile(join(repo, 'AGENTS.md'), '# Agents\n\nTrace run.\n');
  await writeFile(join(repo, 'CLAUDE.md'), '# Claude\n\nTrace run.\n');
  return repo;
}

async function main(): Promise<void> {
  const args = parseArgs();
  await mkdir(join(args.out, 'reference'), { recursive: true });
  const native = new JsonlSink(join(args.out, 'native.jsonl'));
  const modelFile = join(args.out, 'model.jsonl');
  const root = await mkdtemp(join(tmpdir(), 'wdcc-real-trace-'));
  const repo = await sampleRepo(root);
  const isolatedHome = join(root, 'home');
  const isolatedAgentHome = join(root, args.agent === 'codex' ? 'codex-home' : args.agent === 'claude-code' ? 'claude-config' : 'dsh-home');
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(isolatedAgentHome, { recursive: true });
  let proxy: ModelProxy | undefined;
  let adapter: CodexAdapter | ClaudeAdapter | DshAdapter | undefined;
  const sessionId = `trace-${args.agent}-${args.scenario}`;
  const events: AdapterEvent[] = [];
  try {
    const provider = await providerConfig(args.agent);
    const endpoint = args.agent === 'codex' ? provider.config.endpoints?.['openai-responses'] ?? provider.config.baseUrl : provider.config.endpoints?.['anthropic-messages'] ?? provider.config.baseUrl;
    proxy = new ModelProxy({ target: endpoint, port: 0, recordFile: modelFile });
    const address = await proxy.listen();
    const proxiedProvider = {
      ...provider.config,
      baseUrl: address.url,
      endpoints: args.agent === 'codex' ? { 'openai-responses': address.url } as Record<string, string> : { 'anthropic-messages': address.url } as Record<string, string>,
    };
    const env = {
      ...process.env,
      HOME: isolatedHome,
      ...(args.agent === 'codex' ? { CODEX_HOME: isolatedAgentHome } : {}),
      ...(args.agent === 'claude-code' ? { CLAUDE_CONFIG_DIR: isolatedAgentHome } : {}),
      NO_COLOR: '1',
    };
    if (args.agent === 'codex') adapter = new CodexAdapter({ env, traceSink: native });
    else if (args.agent === 'claude-code') adapter = new ClaudeAdapter({ env, traceSink: native, ...(args.model === undefined ? {} : { model: args.model }) });
    else adapter = new DshAdapter({ mode: 'spawn', env, traceSink: native });
    let interrupted = false;
    const activeAdapter = adapter;
    if (activeAdapter === undefined) throw new Error('adapter 未创建');
    activeAdapter.onEvent((id, event) => {
      if (id !== sessionId) return;
      events.push(event);
      if (event.type === 'item.complete' && event.kind === 'approval.request') {
        const data = event.data as { approvalId?: string };
        if (data.approvalId !== undefined) void activeAdapter.respond(sessionId, { approvalId: data.approvalId, optionId: args.scenario === 'S05' ? 'decline' : 'accept' });
      }
      if (event.type === 'item.complete' && event.kind === 'question') {
        const data = event.data as { questionId?: string };
        if (data.questionId !== undefined && 'answer' in activeAdapter && typeof activeAdapter.answer === 'function') void activeAdapter.answer(sessionId, data.questionId, { selected: ['Python'], value: 'Python' });
      }
      if (args.scenario === 'S06' && event.type === 'turn.start' && !interrupted) {
        interrupted = true;
        setTimeout(() => void activeAdapter.interrupt(sessionId), 3000);
      }
    });
    const model = args.model ?? (args.agent === 'codex' ? provider.models[0] : args.agent === 'claude-code' ? provider.models[0] : undefined);
    const accessMode = args.agent === 'codex' ? (args.scenario === 'S04' || args.scenario === 'S05' ? 'workspace' : 'danger-full-access') : 'default';
    const created = await adapter.create({ sessionId, cwd: repo, providerId: provider.id, provider: proxiedProvider, ...(model === undefined ? {} : { model }), accessMode });
    if (created.nativeId !== '') await writeFile(join(args.out, 'native-id.txt'), created.nativeId);
    await adapter.send(sessionId, { text: scenarioPrompts[args.scenario] as string });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !events.some((event) => event.type === 'turn.end' || (event.type === 'item.complete' && event.kind === 'turn.completed'))) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!events.some((event) => event.type === 'turn.end' || (event.type === 'item.complete' && event.kind === 'turn.completed'))) throw new Error('真实轮次 180 秒内没有结束');
    if (args.scenario === 'S10') {
      const firstEnd = events.length;
      await adapter.send(sessionId, { text: '再读 README.md 的第二行。' });
      const secondDeadline = Date.now() + 180_000;
      while (Date.now() < secondDeadline && !events.slice(firstEnd).some((event) => event.type === 'turn.end' || (event.type === 'item.complete' && event.kind === 'turn.completed'))) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const final = events.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete' && event.kind === 'assistant.message').map((event) => String((event.data as { text?: string }).text ?? '')).filter(Boolean).at(-1) ?? '';
    await writeFile(join(args.out, 'reference', 'final.txt'), final);
    await writeFile(join(args.out, 'meta.json'), JSON.stringify({ version: 1, agent: args.agent, scenario: args.scenario, model: model ?? null, prompt: scenarioPrompts[args.scenario], recordedAt: new Date().toISOString(), notTriggered: [] }, null, 2) + '\n');
  } finally {
    await native.flush();
    await adapter?.dispose(sessionId).catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();

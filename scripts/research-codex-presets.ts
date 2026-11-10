/**
 * 调研脚本：核实 Codex CLI 0.167.0 的「访问模式预设」到底是哪几组原生组合。
 *
 * 用法：npx tsx scripts/research-codex-presets.ts [--port 4111] [--keep] [--json]
 *
 * 全程用临时 CODEX_HOME（mkdir temp），不读写用户 ~/.codex；用 mock-responses 假模型。
 * 覆盖：
 *   A. 端点原样 dump：permissionProfile/list、config/read、configRequirements/read、experimentalFeature/list
 *   B. thread/start 回显矩阵：候选预设组合是否被接受、回显成什么
 *   C. turn/start 覆盖是否真的对"本轮 + 后续轮"生效（用审批请求计数 + 实际写文件验证）
 *   D. thread/resume 覆盖是否生效
 *   E. -c 点路径覆盖（approval_policy / sandbox_mode / approvals_reviewer / default_permissions）等价性
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonRpcStdio, type Frame } from './lib/rpc.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';

const MODEL_ID = 'mock-responses-1';
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const jsonOnly = argv.includes('--json');
const portArg = argv.indexOf('--port');
const basePort = portArg >= 0 ? Number(argv[portArg + 1]) : 4111;

const out: string[] = [];
function say(line = ''): void {
  out.push(line);
  if (!jsonOnly) process.stdout.write(`${line}\n`);
}
function head(title: string): void {
  say('');
  say(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  say(`■ ${title}`);
  say(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}
function dump(label: string, value: unknown): void {
  say(`--- ${label} ---`);
  say(JSON.stringify(value, null, 2));
}

interface Ctx {
  rpc: JsonRpcStdio;
  stderr: string[];
  /** 本轮收到的审批反向请求 */
  approvals: Frame[];
  /** thread/settings/updated 通知里的 threadSettings */
  settings: Record<string, unknown>[];
  /** item/completed 的 item 类型 */
  items: string[];
  /** 有任何通知到来时重置的等待器 */
  waiters: Array<() => void>;
}

function buildArgs(mockBaseUrl: string, extra: string[] = []): string[] {
  return [
    'app-server',
    '-c',
    'model_provider=wdcc_mock',
    '-c',
    `model="${MODEL_ID}"`,
    '-c',
    'model_providers.wdcc_mock.name="WDCC mock"',
    '-c',
    `model_providers.wdcc_mock.base_url="${mockBaseUrl}/v1"`,
    '-c',
    'model_providers.wdcc_mock.wire_api="responses"',
    '-c',
    'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"',
    ...extra,
  ];
}

function startApp(args: string[], cwd: string, codexHome: string): Ctx {
  const ctx: Ctx = { rpc: null as unknown as JsonRpcStdio, stderr: [], approvals: [], settings: [], items: [], waiters: [] };
  const rpc = JsonRpcStdio.start({
    command: 'codex',
    args,
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome, WDCC_MOCK_KEY: 'mock-key-not-a-secret' },
    onStderr: (line) => {
      ctx.stderr.push(line);
      if (ctx.stderr.length > 400) ctx.stderr.shift();
    },
  });
  (ctx as { rpc: JsonRpcStdio }).rpc = rpc;

  rpc.onNotification((frame) => {
    const method = String(frame['method']);
    if (method === 'thread/settings/updated') {
      const params = frame['params'] as { threadSettings?: Record<string, unknown> } | undefined;
      if (params?.threadSettings) ctx.settings.push(params.threadSettings);
    }
    if (method === 'item/completed') {
      const params = frame['params'] as { item?: { type?: string } } | undefined;
      if (params?.item?.type) ctx.items.push(params.item.type);
    }
    for (const w of ctx.waiters.splice(0)) w();
  });

  rpc.onServerRequest(async (frame) => {
    const method = String(frame['method']);
    ctx.approvals.push(frame);
    for (const w of ctx.waiters.splice(0)) w();
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: 'accept' };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: 'approved' };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' };
      default:
        return { decision: 'accept' };
    }
  });

  return ctx;
}

async function handshake(ctx: Ctx): Promise<Record<string, unknown>> {
  const init = await ctx.rpc.request<Record<string, unknown>>('initialize', {
    clientInfo: { name: 'webdcc-research', title: 'WebDCC preset research', version: '0.0.0' },
    capabilities: null,
  });
  ctx.rpc.notify('initialized');
  return init;
}

function userInput(text: string): unknown[] {
  return [{ type: 'text', text, text_elements: [] }];
}

/** 等 turn/completed，返回该轮 status；同时给出本轮审批请求数 */
async function runTurn(
  ctx: Ctx,
  threadId: string,
  text: string,
  override: Record<string, unknown> = {},
): Promise<{ status: string; approvals: string[]; items: string[]; settings: Record<string, unknown> | undefined }> {
  ctx.approvals.length = 0;
  ctx.items.length = 0;
  ctx.settings.length = 0;
  const done = ctx.rpc.waitForNotification((f) => f['method'] === 'turn/completed', 180_000);
  await ctx.rpc.request('turn/start', { threadId, input: userInput(text), ...override });
  const frame = await done;
  const status = String(
    ((frame['params'] as { turn?: { status?: string } } | undefined)?.turn ?? {}).status ?? '?',
  );
  return {
    status,
    approvals: ctx.approvals.map((a) => String(a['method'])),
    items: [...ctx.items],
    settings: ctx.settings.at(-1),
  };
}

async function pickPort(): Promise<number> {
  // 只用 4111 及以后；逐个试到能 listen 为止
  for (let p = basePort; p < basePort + 20; p += 1) {
    const probe = await startResponsesMock({ plan: [], port: p, log: () => undefined }).catch(() => null);
    if (probe) {
      await probe.close();
      return p;
    }
  }
  throw new Error(`端口 ${String(basePort)}..${String(basePort + 19)} 都不可用`);
}

const APPROVAL_PLAN: Plan = [
  {
    chunkDelayMs: 10,
    text: '我执行一个写文件的命令。',
    tool: { kind: 'command', name: 'exec_command', input: { cmd: 'printf probe > turn-probe.txt', yield_time_ms: 10000 } },
  },
  { chunkDelayMs: 10, text: '命令已执行完毕。', stopReason: 'end_turn' },
];

async function main(): Promise<void> {
  const port = await pickPort();
  const mock = await startResponsesMock({ plan: APPROVAL_PLAN, port, log: () => undefined });
  const workspace = await mkdtemp(join(tmpdir(), 'wdcc-preset-ws-'));
  const codexHome = await mkdtemp(join(tmpdir(), 'wdcc-preset-home-'));
  await writeFile(join(workspace, 'hello.txt'), 'hello\n', 'utf8');

  say(`codex version : ${process.env['WDCC_CODEX_VERSION'] ?? 'codex-cli 0.167.0'}`);
  say(`mock-responses: ${mock.url}  (port ${String(port)})`);
  say(`workspace     : ${workspace}`);
  say(`CODEX_HOME    : ${codexHome}  (临时，未触碰 ~/.codex)`);

  const ctx = startApp(buildArgs(mock.url), workspace, codexHome);
  const results: Record<string, unknown> = {};

  try {
    const init = await handshake(ctx);
    say(`initialize    : userAgent=${String(init['userAgent'] ?? '?')}`);

    // ───────────────────────── A. 端点原样 dump ─────────────────────────
    head('A. permissionProfile/list（预设的权威来源？）');
    try {
      const profileList = await ctx.rpc.request('permissionProfile/list', { cwd: workspace }, 60_000);
      dump('permissionProfile/list 原始返回', profileList);
      results['permissionProfile/list'] = profileList;
    } catch (error) {
      say(`permissionProfile/list 失败：${String(error)}`);
      results['permissionProfile/list'] = { error: String(error) };
    }

    head('A2. config/read（默认访问模式字段在哪）');
    try {
      const cfg = await ctx.rpc.request<Record<string, unknown>>('config/read', { includeLayers: true, cwd: workspace }, 60_000);
      const config = (cfg['config'] ?? {}) as Record<string, unknown>;
      const interesting: Record<string, unknown> = {};
      for (const key of [
        'approval_policy',
        'approvals_reviewer',
        'sandbox_mode',
        'sandbox_workspace_write',
        'default_permissions',
        'permission_profile',
        'permissions',
        'model',
        'model_provider',
      ]) {
        if (key in config) interesting[key] = config[key];
      }
      dump('config/read → config 里与访问模式相关的字段', interesting);
      dump('config/read → config 的全部字段名',
        Object.keys(config).filter((k) => k !== 'model_providers').sort());
      results['config/read'] = interesting;
      dump('config/read → origins', cfg['origins'] ?? null);
    } catch (error) {
      say(`config/read 失败：${String(error)}`);
    }

    head('A3. configRequirements/read（托管策略限制）');
    try {
      const req = await ctx.rpc.request('configRequirements/read', undefined, 60_000);
      dump('configRequirements/read 原始返回', req);
      results['configRequirements/read'] = req;
    } catch (error) {
      say(`configRequirements/read 失败：${String(error)}`);
    }

    head('A4. experimentalFeature/list（预设是否被实验开关门控）');
    try {
      const feats = await ctx.rpc.request('experimentalFeature/list', { cwd: workspace }, 60_000);
      dump('experimentalFeature/list 原始返回', feats);
      results['experimentalFeature/list'] = feats;
    } catch (error) {
      say(`experimentalFeature/list 失败：${String(error)}`);
    }

    // ───────────────── B. thread/start 回显矩阵 ─────────────────
    head('B. thread/start 回显矩阵：候选预设组合是否被接受、回显成什么');
    const combos: Array<{ name: string; params: Record<string, unknown> }> = [
      { name: '① 基线（全不传，看服务端默认）', params: {} },
      { name: '② Full Access 候选', params: { approvalPolicy: 'never', sandbox: 'danger-full-access' } },
      { name: '③ Auto/Approve-for-me 候选', params: { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' } },
      { name: '④ Auto（不带 reviewer 的朴素版）', params: { approvalPolicy: 'on-request', sandbox: 'workspace-write' } },
      { name: '⑤ Read Only 候选', params: { approvalPolicy: 'untrusted', sandbox: 'read-only' } },
      { name: '⑥ untrusted + workspace-write', params: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } },
      { name: '⑦ granular 审批', params: { approvalPolicy: { granular: { sandbox_approval: true, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: false } }, sandbox: 'workspace-write' } },
    ];
    const matrix: Array<Record<string, unknown>> = [];
    for (const combo of combos) {
      try {
        const started = await ctx.rpc.request<Record<string, unknown>>('thread/start', {
          cwd: workspace,
          model: MODEL_ID,
          ...combo.params,
        }, 60_000);
        const row = {
          combo: combo.name,
          request: combo.params,
          'echo.approvalPolicy': started['approvalPolicy'],
          'echo.approvalsReviewer': started['approvalsReviewer'],
          'echo.sandbox': started['sandbox'],
        };
        matrix.push(row);
        say(`✔ ${combo.name}`);
        say(`    请求 = ${JSON.stringify(combo.params)}`);
        say(`    回显 approvalPolicy    = ${JSON.stringify(row['echo.approvalPolicy'])}`);
        say(`    回显 approvalsReviewer = ${JSON.stringify(row['echo.approvalsReviewer'])}`);
        say(`    回显 sandbox           = ${JSON.stringify(row['echo.sandbox'])}`);
        await ctx.rpc.request('thread/archive', { threadId: (started['thread'] as { id: string }).id }).catch(() => undefined);
      } catch (error) {
        say(`✘ ${combo.name} 失败：${String(error)}`);
        matrix.push({ combo: combo.name, request: combo.params, error: String(error) });
      }
    }
    results['threadStartMatrix'] = matrix;

    // ───────────────── C. turn/start 覆盖：真的生效吗、作用域多大 ─────────────────
    head('C. turn/start 的 approvalPolicy 覆盖：对"本轮"和"后续轮"是否都生效');
    const probeThread = await ctx.rpc.request<Record<string, unknown>>('thread/start', {
      cwd: workspace,
      model: MODEL_ID,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    }, 60_000);
    const probeThreadId = (probeThread['thread'] as { id: string }).id;
    say(`探针线程 threadId=${probeThreadId}，初始 approvalPolicy=never sandbox=workspace-write`);

    const steps: Array<{ label: string; override: Record<string, unknown>; expect: string }> = [
      { label: 'C1 不覆盖（继承 never）', override: {}, expect: '不应有审批' },
      { label: 'C2 覆盖 approvalPolicy=untrusted（本轮）', override: { approvalPolicy: 'untrusted' }, expect: '应有审批' },
      { label: 'C3 再不覆盖（验证是否"后续轮"延续）', override: {}, expect: '若延续 untrusted 则有审批' },
      { label: 'C4 覆盖回 approvalPolicy=never', override: { approvalPolicy: 'never' }, expect: '不应有审批' },
      { label: 'C5 覆盖 sandboxPolicy 为 readOnly（写命令应失败）', override: { sandboxPolicy: { type: 'readOnly', networkAccess: false } }, expect: '写文件被沙箱拒绝' },
    ];
    const turnRows: Array<Record<string, unknown>> = [];
    for (const step of steps) {
      const before = await readFile(join(workspace, 'turn-probe.txt'), 'utf8').catch(() => null);
      const result = await runTurn(ctx, probeThreadId, `${step.label}：请执行计划中的写文件命令。`, step.override);
      const after = await readFile(join(workspace, 'turn-probe.txt'), 'utf8').catch(() => null);
      const row = {
        step: step.label,
        override: step.override,
        turnStatus: result.status,
        approvalRequests: result.approvals,
        written: before !== after,
        itemTypes: result.items,
        'settings.approvalPolicy': result.settings?.['approvalPolicy'],
        'settings.approvalsReviewer': result.settings?.['approvalsReviewer'],
        'settings.sandboxPolicy': result.settings?.['sandboxPolicy'],
        'settings.activePermissionProfile': result.settings?.['activePermissionProfile'],
      };
      turnRows.push(row);
      say(`\n${step.label}  期望：${step.expect}`);
      say(`  审批反向请求 (${result.approvals.length})：${result.approvals.join(', ') || '（无）'}`);
      say(`  本轮回显 settings：approvalPolicy=${JSON.stringify(row['settings.approvalPolicy'])} ` +
          `sandboxPolicy=${JSON.stringify(row['settings.sandboxPolicy'])} ` +
          `activePermissionProfile=${JSON.stringify(row['settings.activePermissionProfile'])}`);
      say(`  item 类型：${result.items.join(', ') || '（无）'}；turn-probe.txt 本轮被改动=${String(row.written)}`);
      // 清掉文件，保证下一轮 before/after 比较有意义
      await rm(join(workspace, 'turn-probe.txt'), { force: true });
    }
    results['turnStartOverride'] = turnRows;

    // ───────────────── D. thread/resume 覆盖 ─────────────────
    head('D. thread/resume 的 approvalPolicy/sandbox 覆盖');
    const resumeRows: Array<Record<string, unknown>> = [];
    for (const spec of [
      { label: 'D1 resume 覆盖为 never + danger-full-access', params: { approvalPolicy: 'never', sandbox: 'danger-full-access' } },
      { label: 'D2 resume 覆盖为 untrusted + read-only', params: { approvalPolicy: 'untrusted', sandbox: 'read-only' } },
    ]) {
      try {
        const resumed = await ctx.rpc.request<Record<string, unknown>>('thread/resume', {
          threadId: probeThreadId,
          model: MODEL_ID,
          ...spec.params,
        }, 60_000);
        const row = {
          step: spec.label,
          request: spec.params,
          'echo.approvalPolicy': resumed['approvalPolicy'],
          'echo.approvalsReviewer': resumed['approvalsReviewer'],
          'echo.sandbox': resumed['sandbox'],
        };
        resumeRows.push(row);
        say(`✔ ${spec.label} → approvalPolicy=${JSON.stringify(row['echo.approvalPolicy'])} sandbox=${JSON.stringify(row['echo.sandbox'])}`);
      } catch (error) {
        say(`✘ ${spec.label} 失败：${String(error)}`);
        resumeRows.push({ step: spec.label, error: String(error) });
      }
    }
    results['threadResumeOverride'] = resumeRows;

    await ctx.rpc.kill('SIGKILL');

    // ───────────────── E. -c 点路径覆盖等价性 ─────────────────
    head('E. `-c` 点路径覆盖：approval_policy / sandbox_mode / approvals_reviewer / default_permissions');
    const cfgRows: Array<Record<string, unknown>> = [];
    for (const spec of [
      { label: 'E1 -c approval_policy=untrusted -c sandbox_mode=read-only', extra: ['-c', 'approval_policy="untrusted"', '-c', 'sandbox_mode="read-only"'] },
      { label: 'E2 -c approvals_reviewer=auto_review', extra: ['-c', 'approvals_reviewer="auto_review"'] },
      { label: 'E3 -c default_permissions=":read-only"', extra: ['-c', 'default_permissions=":read-only"'] },
      { label: 'E4 -c default_permissions=":workspace"', extra: ['-c', 'default_permissions=":workspace"'] },
      { label: 'E5 -c default_permissions=":danger-full-access"', extra: ['-c', 'default_permissions=":danger-full-access"'] },
      { label: 'E6 同时给 sandbox_mode 和 default_permissions（应当冲突）', extra: ['-c', 'sandbox_mode="read-only"', '-c', 'default_permissions=":workspace"'] },
      { label: 'E7 -c permission_profile=":read-only"', extra: ['-c', 'permission_profile=":read-only"'] },
    ]) {
      const sub = startApp(buildArgs(mock.url, spec.extra), workspace, codexHome);
      try {
        await handshake(sub);
        const started = await sub.rpc.request<Record<string, unknown>>('thread/start', { cwd: workspace, model: MODEL_ID }, 60_000);
        const row = {
          step: spec.label,
          'echo.approvalPolicy': started['approvalPolicy'],
          'echo.approvalsReviewer': started['approvalsReviewer'],
          'echo.sandbox': started['sandbox'],
        };
        cfgRows.push(row);
        say(`✔ ${spec.label}`);
        say(`    → approvalPolicy=${JSON.stringify(row['echo.approvalPolicy'])} reviewer=${JSON.stringify(row['echo.approvalsReviewer'])} sandbox=${JSON.stringify(row['echo.sandbox'])}`);
      } catch (error) {
        const tail = sub.stderr.slice(-6).join('\n            ');
        say(`✘ ${spec.label} 失败：${String(error)}`);
        if (tail) say(`    stderr 末几行：\n            ${tail}`);
        cfgRows.push({ step: spec.label, error: String(error), stderrTail: sub.stderr.slice(-12) });
      } finally {
        await sub.rpc.kill().catch(() => undefined);
      }
    }
    results['configOverrides'] = cfgRows;

    // ───────────────── F. 补测：granular / 冷启动 resume / 自定义 profile ─────────────────
    head('F1. granular 审批策略需要 experimentalApi capability 才能用');
    for (const cap of [false, true]) {
      const sub = startApp(buildArgs(mock.url), workspace, codexHome);
      try {
        const initSub = await sub.rpc.request<Record<string, unknown>>('initialize', {
          clientInfo: { name: 'webdcc-research', title: 'WebDCC preset research', version: '0.0.0' },
          capabilities: cap ? { experimentalApi: true } : null,
        });
        say(`  initialize(capabilities=${cap ? '{experimentalApi:true}' : 'null'}) → ${JSON.stringify(initSub)}`);
        sub.rpc.notify('initialized');
        const granular = {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: false,
            request_permissions: true,
            mcp_elicitations: false,
          },
        };
        const started = await sub.rpc.request<Record<string, unknown>>('thread/start', {
          cwd: workspace,
          model: MODEL_ID,
          approvalPolicy: granular,
          sandbox: 'workspace-write',
        }, 60_000);
        say(`  ✔ capabilities.experimentalApi=${String(cap)} 时 granular 可用 → 回显 approvalPolicy=${JSON.stringify(started['approvalPolicy'])}`);
      } catch (error) {
        say(`  ✘ capabilities.experimentalApi=${String(cap)} 时 granular 失败 → ${String(error)}`);
      } finally {
        await sub.rpc.kill().catch(() => undefined);
      }
    }

    head('F2. 冷启动（新进程、thread 未加载）时 thread/resume 的覆盖是否生效');
    const cold = startApp(buildArgs(mock.url), workspace, codexHome);
    try {
      await handshake(cold);
      for (const spec of [
        { label: 'F2a 覆盖 never + danger-full-access', params: { approvalPolicy: 'never', sandbox: 'danger-full-access' } },
        { label: 'F2b 覆盖 on-request + read-only + auto_review', params: { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'auto_review' } },
      ]) {
        try {
          const resumed = await cold.rpc.request<Record<string, unknown>>('thread/resume', {
            threadId: probeThreadId,
            model: MODEL_ID,
            ...spec.params,
          }, 60_000);
          say(`  ✔ ${spec.label}`);
          say(`      → approvalPolicy=${JSON.stringify(resumed['approvalPolicy'])} reviewer=${JSON.stringify(resumed['approvalsReviewer'])} sandbox=${JSON.stringify(resumed['sandbox'])}`);
          results[`coldResume:${spec.label}`] = {
            request: spec.params,
            approvalPolicy: resumed['approvalPolicy'],
            approvalsReviewer: resumed['approvalsReviewer'],
            sandbox: resumed['sandbox'],
          };
        } catch (error) {
          say(`  ✘ ${spec.label} 失败：${String(error)}`);
        }
      }
    } finally {
      await cold.rpc.kill().catch(() => undefined);
    }

    head('F3. 自定义 [permissions.<id>] profile 会不会出现在 permissionProfile/list 里');
    const customHome = await mkdtemp(join(tmpdir(), 'wdcc-preset-home2-'));
    await writeFile(
      join(customHome, 'config.toml'),
      // 注意：`network` 必须是表（NetworkToml），写成 `network = true` 会报
      // "invalid type: boolean `true`, expected struct NetworkToml"
      ['default_permissions = "custom-web"', '', '[permissions.custom-web]', 'extends = ":workspace"', '', '[permissions.custom-web.network]', 'enabled = true', ''].join('\n'),
      'utf8',
    );
    const custom = startApp(buildArgs(mock.url), workspace, customHome);
    try {
      await handshake(custom);
      const list = await custom.rpc.request('permissionProfile/list', { cwd: workspace }, 60_000);
      dump('带自定义 profile 时 permissionProfile/list', list);
      results['customProfileList'] = list;
      const started = await custom.rpc.request<Record<string, unknown>>('thread/start', { cwd: workspace, model: MODEL_ID }, 60_000);
      say(`  thread/start 回显 sandbox=${JSON.stringify(started['sandbox'])} approvalPolicy=${JSON.stringify(started['approvalPolicy'])}`);
      results['customProfileThreadStart'] = { sandbox: started['sandbox'], approvalPolicy: started['approvalPolicy'] };
    } catch (error) {
      say(`  ✘ 自定义 profile 测试失败：${String(error)}`);
      say(`    stderr 末几行：${custom.stderr.slice(-5).join(' | ')}`);
    } finally {
      await custom.rpc.kill().catch(() => undefined);
      await rm(customHome, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await ctx.rpc.kill().catch(() => undefined);
    await mock.close().catch(() => undefined);
    if (keep) {
      say(`\n（--keep）保留工作区：${workspace}`);
      say(`（--keep）保留 CODEX_HOME：${codexHome}`);
    } else {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  head('结论速览');
  const list = (results['permissionProfile/list'] ?? {}) as { data?: Array<Record<string, unknown>> };
  if (Array.isArray(list.data)) {
    say(`permissionProfile/list 返回 ${String(list.data.length)} 项：`);
    for (const p of list.data) {
      say(`  · id=${JSON.stringify(p['id'])} allowed=${JSON.stringify(p['allowed'])} description=${JSON.stringify(p['description'])}`);
    }
  } else {
    say('permissionProfile/list 未返回 data 数组，见上面原始输出。');
  }

  if (jsonOnly) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else await writeFile(join(tmpdir(), 'wdcc-research-codex-presets.json'), JSON.stringify(results, null, 2), 'utf8');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`调研脚本失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}

import { describe, expect, it } from 'vitest';
import {
  buildThreadStartParams,
  buildTurnStartParams,
  CodexAdapter,
} from '../codex/src/adapter.js';
import { ClaudeAdapter } from '../claude/src/adapter.js';
import { ALLOWED_ENDPOINTS, DshAdapter, isAllowedCommandLine, isAllowedEndpoint } from '../dsh/src/adapter.js';

const FORBIDDEN = ['baseInstructions', 'developerInstructions'];
const ALLOWED_CONFIG_KEYS = [
  'model',
  'model_provider',
  'model_providers.',
  'model_catalog_json',
  'show_raw_agent_reasoning',
];

describe('原装原则：Codex（SPEC 3.3）', () => {
  const opts = { sessionId: 's1', cwd: '/tmp/ws', providerId: null, accessMode: 'workspace' };

  it('thread/start 参数里没有任何提示词字段', () => {
    const params = buildThreadStartParams(opts);
    for (const key of FORBIDDEN) expect(params).not.toHaveProperty(key);
    expect(Object.keys(params).sort()).toEqual(['approvalPolicy', 'approvalsReviewer', 'cwd', 'sandbox']);
  });

  it('turn/start 参数里没有任何提示词字段，且文本逐字透传', () => {
    const text = '  原样文本\n第二行 @文件  ';
    const params = buildTurnStartParams('thread-1', text);
    for (const key of FORBIDDEN) expect(params).not.toHaveProperty(key);
    const input = params['input'] as { type: string; text: string }[];
    expect(input[0]?.text).toBe(text);
  });

  it('buildLaunchSpec 的 -c 覆盖只含白名单键', () => {
    const adapter = new CodexAdapter({
      configOverrides: [
        'model_provider=wdcc_x',
        'model_providers.wdcc_x.base_url="http://127.0.0.1:1/v1"',
        'model_catalog_json="/tmp/x.json"',
        'show_raw_agent_reasoning=true',
      ],
    });
    const spec = adapter.buildLaunchSpec(opts);
    const args = spec.args ?? [];
    const configs: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-c') configs.push(args[i + 1] ?? '');
    }
    expect(configs.length).toBeGreaterThan(0);
    for (const entry of configs) {
      const key = entry.split('=')[0] ?? '';
      expect(
        ALLOWED_CONFIG_KEYS.some((allowed) => key === allowed || key.startsWith(allowed)),
        `不允许的 -c 键：${key}`,
      ).toBe(true);
      expect(entry).not.toContain('base_instructions');
      expect(entry).not.toContain('developer_instructions');
    }
  });

  it('访问模式映射到 Codex 原生枚举', () => {
    expect(buildThreadStartParams({ ...opts, accessMode: 'read-only' })).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      approvalsReviewer: 'user',
    });
    expect(buildThreadStartParams({ ...opts, accessMode: 'danger-full-access' })).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(buildThreadStartParams({ ...opts, accessMode: 'workspace-auto' })).toMatchObject({
      approvalsReviewer: 'auto_review',
    });
  });
});


describe('原装原则：Claude Code（SPEC 3.3）', () => {
  const opts = { sessionId: 's2', cwd: '/tmp/ws', providerId: null };
  const adapter = new ClaudeAdapter();
  const sdkOptions = adapter.buildLaunchSpec(opts).sdkOptions as Record<string, unknown>;

  it('systemPrompt 深等于 claude_code preset，且没有 append', () => {
    expect(sdkOptions['systemPrompt']).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(sdkOptions).not.toHaveProperty('append');
    expect(JSON.stringify(sdkOptions)).not.toContain('"append"');
  });

  it('settingSources 深等于 user/project/local', () => {
    expect(sdkOptions['settingSources']).toEqual(['user', 'project', 'local']);
  });

  it('不存在 mcpServers / agents / hooks / allowedTools / disallowedTools', () => {
    for (const key of ['mcpServers', 'agents', 'hooks', 'allowedTools', 'disallowedTools']) {
      expect(sdkOptions, key).not.toHaveProperty(key);
    }
  });

  it('六种原生 permissionMode 都原样透传', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']) {
      const spec = adapter.buildLaunchSpec({ ...opts, accessMode: mode });
      expect((spec.sdkOptions as Record<string, unknown>)['permissionMode']).toBe(mode);
    }
  });
});


describe('原装原则：DSH（SPEC 5.4.8）', () => {
  it('启动参数只有一个 loopback 侧车，不带 profile/plugin/config', () => {
    const adapter = new DshAdapter({ port: 3091 });
    const spec = adapter.buildLaunchSpec();
    const args = [spec.command ?? '', ...(spec.args ?? [])].join(' ');
    expect(args).toContain('dsh web --no-open --port 3091 --host 127.0.0.1');
    expect(args).not.toContain('--profile');
    expect(args).not.toContain('plugin');
    expect(spec.env).toEqual({});
  });

  it('端点白名单就是 5.4.8 列出的那些', () => {
    expect([...ALLOWED_ENDPOINTS].sort()).toEqual(
      [
        '$events',
        '$events/result',
        'commands/execute',
        'session/cancel',
        'session/create',
        'session/follow',
        'session/list',
        'session/modelCatalog',
        'session/page',
        'session/prompt',
        'session/selectModel',
        'userQuestions/answer',
        'workspace/create',
        'workspace/follow',
      ].sort(),
    );
    expect(isAllowedEndpoint('host/describe')).toBe(false);
    expect(isAllowedEndpoint('settings/mutate')).toBe(false);
    expect(isAllowedEndpoint('pluginManager/install')).toBe(false);
  });

  it('commands/execute 只允许 /permission 或用户原文', () => {
    expect(isAllowedCommandLine('/permission workspace-write')).toBe(true);
    expect(isAllowedCommandLine('/permission danger-full-access')).toBe(true);
    expect(isAllowedCommandLine('/permission evil-mode')).toBe(false);
    expect(isAllowedCommandLine('/compact')).toBe(false);
    expect(isAllowedCommandLine('/compact', '/compact')).toBe(true);
    // /permission 由访问模式界面生成，与用户文本无关
    expect(isAllowedCommandLine('/permission read-only', '别的文本')).toBe(true);
  });

  it('四档访问模式与界面文字一致', () => {
    const adapter = new DshAdapter();
    expect(adapter.accessModes().map((mode) => mode.id)).toEqual(['read-only', 'workspace-write', 'danger-full-access', 'auto']);
  });
});

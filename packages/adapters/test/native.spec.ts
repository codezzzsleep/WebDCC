import { describe, expect, it } from 'vitest';
import {
  buildThreadStartParams,
  buildTurnStartParams,
  CodexAdapter,
} from '../codex/src/adapter.js';
import { ClaudeAdapter } from '../claude/src/adapter.js';

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

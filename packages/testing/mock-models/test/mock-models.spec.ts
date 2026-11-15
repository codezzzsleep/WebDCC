import { afterEach, describe, expect, it } from 'vitest';

import { countToolResults, createAnthropicMock, defaultToolInput, type RunningMock } from '../src/anthropic-server.js';
import { pickToolName, resolveTool, stepAt } from '../src/plan.js';
import { codeModeScript, countFunctionCallOutputs, startResponsesMock } from '../src/responses-server.js';
import { countResponses, MockControl } from '../src/mock-control.js';

describe('plan 工具匹配', () => {
  const codexTools = [
    { type: 'function', name: 'exec_command' },
    { type: 'function', name: 'write_stdin' },
    { type: 'function', name: 'create_goal' },
    { type: 'web_search' } as unknown as { name: string },
  ];

  it('command 命中 exec_command', () => {
    expect(pickToolName('command', codexTools)).toBe('exec_command');
  });

  it('write 不会误命中 write_stdin', () => {
    expect(pickToolName('write', codexTools)).toBeUndefined();
  });

  it('没有 name 的内置工具不会抛错', () => {
    expect(() => pickToolName('read', codexTools)).not.toThrow();
  });

  it('alternatives 在首选工具不存在时生效', () => {
    const resolved = resolveTool(
      {
        kind: 'write',
        input: { file_path: './a.txt', content: 'x' },
        alternatives: [{ kind: 'command', name: 'exec_command', input: { cmd: 'touch a.txt' } }],
      },
      codexTools,
    );
    expect(resolved?.name).toBe('exec_command');
    expect(resolved?.input).toEqual({ cmd: 'touch a.txt' });
  });

  it('inputByName 按原生工具名覆盖入参', () => {
    const resolved = resolveTool(
      { kind: 'command', input: { command: 'ls' }, inputByName: { exec_command: { cmd: 'ls -la' } } },
      codexTools,
    );
    expect(resolved?.input).toEqual({ cmd: 'ls -la' });
  });

  it('计划耗尽时返回兜底项', () => {
    expect(stepAt([{ text: 'only' }], 5).stopReason).toBe('end_turn');
  });
});

describe('native Responses question transports', () => {
  const questions = [{ title: 'Environment?', options: ['Stage', 'Prod'] }];
  const tools = [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }, { type: 'function', name: 'request_user_input_async' }] }];
  const additional = { type: 'additional_tools', tools };

  it('synchronous nested ask respects the resolved tool name', () => {
    expect(codeModeScript({ tool: { kind: 'ask', input: { questions: [] } } }, 'request_user_input')).toContain('tools.request_user_input(');
    expect(codeModeScript({ tool: { kind: 'ask', input: { questions: [] } } }, 'ask_human')).toContain('tools.ask_human(');
  });

  it('async namespace question is a direct function even beside code-mode exec; an answer preserves the continuation cursor', async () => {
    const plan = [{ tool: { kind: 'ask' as const, name: 'request_user_input_async', namespace: 'functions', callId: 'async-fixture', input: { questions } } }, { text: 'Continue after native accepted' }];
    const control = new MockControl(plan, '');
    const model = await startResponsesMock({ plan, control, log: () => undefined });
    try {
      const initial = await fetch(model.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', input: [additional, { type: 'message', role: 'user', content: 'Ask' }] }) });
      expect(initial.status).toBe(200);
      const text = await initial.text();
      expect(text).toContain('"namespace":"functions"');
      expect(text).toContain('"name":"request_user_input_async"');
      expect(text).toContain('"call_id":"async-fixture"');
      expect(text).not.toContain('custom_tool_call');
      expect(text).not.toContain('tools.request_user_input_async');
      const answer = '<send_user_message_question_reply>\n[{"questionItemId":"id","question":"Environment?","answer":"Prod"}]\n</send_user_message_question_reply>';
      const continuation = await fetch(model.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', input: [additional, { type: 'message', role: 'user', content: answer }] }) });
      expect(continuation.status).toBe(200);
      const continued = await continuation.text();
      expect(continued).toContain('Continue after native accepted');
      expect(continued).not.toContain('function_call');
      expect(control.requests.every(request => request.failed !== true)).toBe(true);
    } finally { await model.close(); }
  });

  it('a positive async plan fails when the native catalog does not declare the namespace tool', async () => {
    const plan = [{ tool: { kind: 'ask' as const, name: 'request_user_input_async', namespace: 'functions', input: { questions } } }];
    const control = new MockControl(plan, ''); const model = await startResponsesMock({ plan, control, log: () => undefined });
    try {
      const response = await fetch(model.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'unsupported-native-catalog', input: [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }] }, { type: 'message', role: 'user', content: 'Ask' }] }) });
      expect(response.status).toBe(500); expect(control.requests.at(-1)?.failed).toBe(true);
      expect(await response.text()).toContain('mock_tool_mismatch');
    } finally { await model.close(); }
  });
});

describe('工具结果计数（按当前轮）', () => {
  it('Anthropic：跨轮不累计上一轮的工具结果', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好了' }] },
      { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
    ];
    expect(countToolResults(messages)).toBe(0);
  });

  it('Anthropic：同一轮内累加', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '轮次' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2' }, { type: 'tool_result', tool_use_id: 't3' }] },
    ];
    expect(countToolResults(messages)).toBe(3);
  });

  it('Responses：同一用户消息重复出现时保留计划游标，新消息才重置', () => {
    const input = [
      { type: 'message', id: 'u1', role: 'user' },
      { type: 'function_call_output' },
      { type: 'message', id: 'u1', role: 'user' },
      { type: 'function_call_output' },
    ];
    expect(countFunctionCallOutputs(input)).toBe(2);
    expect(countFunctionCallOutputs([...input, { type: 'message', id: 'u2', role: 'user' }])).toBe(0);
  });

  it('Responses：工具结果消息不计入历史用户消息数', () => {
    const result = countResponses({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一轮' }] },
        { type: 'custom_tool_call_output', output: 'ok' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二轮' }] },
        { type: 'message', role: 'user', content: [{ type: 'custom_tool_call_output', output: 'ok' }] },
      ],
    });
    expect(result.userMessageCount).toBe(2);
  });
});

describe('mock-anthropic 流式响应', () => {
  let mock: RunningMock | undefined;

  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it('按计划回放 text → tool_use，并按请求里的 tools 选工具', async () => {
    mock = createAnthropicMock({
      plan: [
        { text: '先看目录', tool: { kind: 'command' } },
        { text: '完成' },
      ],
      log: () => undefined,
    });
    await new Promise<void>((resolve) => mock?.server.listen(0, '127.0.0.1', () => resolve()));
    const address = mock.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: message_start');
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"bash"');
    expect(body).toContain('event: message_stop');
    expect(body).toContain('"stop_reason":"tool_use"');
  });

  it('未知端点返回 404', async () => {
    mock = createAnthropicMock({ plan: [], log: () => undefined });
    await new Promise<void>((resolve) => mock?.server.listen(0, '127.0.0.1', () => resolve()));
    const address = mock.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/unknown`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  it('默认入参对 DSH 与 Claude 的语义工具都合法', () => {
    expect(defaultToolInput('command')['command']).toBeTypeOf('string');
    expect(defaultToolInput('read')['file_path']).toBeTypeOf('string');
    expect(defaultToolInput('ask')['questions']).toBeInstanceOf(Array);
  });
});

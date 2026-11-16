import { expect, it } from 'vitest';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { EventData } from '@webdcc/protocol';
import { ClaudeAdapter } from '../src/adapter.js';
import { permissionSuggestions } from '../src/permission-proposal.js';

const suggestions = (): PermissionUpdate[] => [
  { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'pwd' }] },
  { type: 'addDirectories', destination: 'cliArg', directories: ['/tmp/project'] },
];
function prompt(options: Record<string, unknown> = {}) {
  const replay = ClaudeAdapter.replay('local');
  const input = { command: 'pwd' };
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName: 'Bash', input, toolUseID: 'tool', ...options } });
  const event = events.find(event => event.type === 'item.complete' && event.kind === 'approval.request');
  if (event?.type !== 'item.complete') throw new Error('No approval');
  return { ...replay, input, approval: event.data as EventData['approval.request'] };
}

it('native suggested authorization returns the complete original update set with its exact destinations', async () => {
  const updates = suggestions(); const ctx = prompt({ suggestions: updates });
  const option = ctx.approval.options.find(option => option.id === 'allow-native-suggestions');
  expect(option?.label).toContain('会话'); expect(option?.label).toContain('启动参数');
  expect(ctx.approval.detail).toContain('pwd'); expect(ctx.approval.detail).toContain('/tmp/project');
  await ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId: 'allow-native-suggestions' });
  await expect.poll(() => ctx.decisions).toEqual([{ behavior: 'allow', updatedInput: ctx.input, updatedPermissions: updates }]);
});

it('allow once never applies permission suggestions and denial never grants anything', async () => {
  for (const optionId of ['allow', 'deny']) {
    const ctx = prompt({ suggestions: suggestions() });
    await ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId });
    await expect.poll(() => ctx.decisions.length).toBe(1);
    expect(ctx.decisions[0]).toEqual(optionId === 'allow' ? { behavior: 'allow', updatedInput: ctx.input } : { behavior: 'deny', message: '用户拒绝', interrupt: true });
  }
});

it.each([undefined, [], suggestions()])('suppressed or absent suggestions cannot be selected as a persistent grant (%j)', async updates => {
  const ctx = prompt({ suggestions: updates, suppressAlwaysAllowRule: true });
  expect(ctx.approval.options.map(option => option.id)).toEqual(['allow', 'deny']);
  await expect(ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId: 'allow-native-suggestions' })).rejects.toMatchObject({ statusCode: 400 });
  expect(ctx.decisions).toEqual([]);
  await ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId: 'deny' });
  await expect.poll(() => ctx.decisions[0]).toMatchObject({ behavior: 'deny' });
});

it('unknown decision ids do not resolve the native prompt and cancellation retains native denial', async () => {
  const ctx = prompt({ suggestions: suggestions() });
  await expect(ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId: 'invented-grant' })).rejects.toMatchObject({ statusCode: 400 });
  expect(ctx.decisions).toEqual([]); await ctx.adapter.cancelPending('local');
  await expect.poll(() => ctx.decisions[0]).toMatchObject({ behavior: 'deny' });
});

it('permission proposals are snapshotted when shown, so a later caller mutation cannot widen the selected update', async () => {
  const updates = suggestions(); const expected = structuredClone(updates); const ctx = prompt({ suggestions: updates });
  if (updates[0]?.type === 'addRules') updates[0].rules[0]!.ruleContent = '*';
  await ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId: 'allow-native-suggestions' });
  await expect.poll(() => ctx.decisions[0]).toEqual({ behavior: 'allow', updatedInput: ctx.input, updatedPermissions: expected });
});

it('the native default-to-no flag orders decline first while retaining an explicit suggested grant', async () => {
  const ctx = prompt({ suggestions: suggestions(), defaultToNo: true });
  expect(ctx.approval.options.map(option => option.id)).toEqual(['deny', 'allow', 'allow-native-suggestions']);
  await ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId: 'deny' });
  await expect.poll(() => ctx.decisions[0]).toMatchObject({ behavior: 'deny' });
});

it('the pinned PermissionUpdate variants preserve all fields as one proposal', () => {
  const updates: PermissionUpdate[] = [...suggestions(),
    { type: 'replaceRules', destination: 'userSettings', behavior: 'ask', rules: [{ toolName: 'Read' }] },
    { type: 'removeRules', destination: 'projectSettings', behavior: 'deny', rules: [{ toolName: 'Write' }] },
    { type: 'setMode', destination: 'localSettings', mode: 'plan' },
    { type: 'removeDirectories', destination: 'session', directories: ['/tmp/removed'] },
  ];
  expect(permissionSuggestions(updates)).toEqual(updates);
});

it.each([
  { type: 'addRules', destination: 'global', behavior: 'allow', rules: [] },
  { type: 'setMode', destination: 'session', mode: 'unknown' },
  { type: 'addRules', destination: 'session', behavior: 'unknown', rules: [] },
  { type: 'addDirectories', destination: 'session', directories: [42] },
  { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 42 }] },
  { type: 'setMode', destination: 'session', mode: 'plan', inventedField: true },
])('a malformed update cannot be dropped while the rest of the native set is granted (%j)', async invalid => {
  const ctx = prompt({ suggestions: [...suggestions(), invalid] });
  expect(ctx.approval.options.map(option => option.id)).toEqual(['allow', 'deny']);
  await ctx.adapter.respond('local', { approvalId: ctx.approval.approvalId, optionId: 'deny' });
  await expect.poll(() => ctx.decisions[0]).toMatchObject({ behavior: 'deny' });
});

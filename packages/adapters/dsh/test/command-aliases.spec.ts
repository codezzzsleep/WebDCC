import { expect, it, vi } from 'vitest';
import { slashCommandFor } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import { dshCommandAliases } from '../src/commands.js';
import preview from '../src/slash-catalog.json' with { type: 'json' };

// Actual Host0.2.2-rc.1 identities/names; descriptions are controlled fixtures.
const descriptors = [
  { definitionId: '@deepseek-ai/dsh-command-goal', name: 'goal', alias: '目标' },
  { definitionId: '@deepseek-ai/dsh-plan-mode', name: 'plan', alias: '计划' },
  { definitionId: '@deepseek-ai/dsh-command-feedback', name: 'feedback', alias: '反馈' },
  { definitionId: '@deepseek-ai/dsh-command-compact', name: 'compact', alias: '压缩' },
  { definitionId: '@deepseek-ai/dsh-permission-presets', name: 'permission', alias: '权限' },
  { definitionId: '@deepseek-ai/dsh-session-log-export', name: 'export', alias: '导出' },
];

async function catalog(values = descriptors.map(({ definitionId, name }) => ({ definitionId, name, description: 'native descriptor' }))) {
  const adapter = new DshAdapter();
  const stub = adapter as unknown as { ensureSidecar(): Promise<unknown>; call(): Promise<unknown> };
  vi.spyOn(stub, 'ensureSidecar').mockResolvedValue({});
  vi.spyOn(stub, 'call').mockResolvedValue({ commands: values });
  return adapter.slashCommands('controlled-session');
}

it.each(descriptors)('retains $definitionId and maps the native spelling /$alias to its registered /$name', async descriptor => {
  const commands = await catalog();
  const english = slashCommandFor(commands, `/${descriptor.name}  original\r\nargument`);
  const chinese = slashCommandFor(commands, `/${descriptor.alias}  original\r\nargument`);
  expect(chinese).toBe(english);
  expect(chinese).toMatchObject({ name: `/${descriptor.name}`, definitionId: descriptor.definitionId, route: 'native-control' });
});

it('aliases follow first-party definition identity after renaming while exact scoped/custom names win', async () => {
  const goal = descriptors[0]!;
  const commands = await catalog([
    { name: 'goal', definitionId: 'custom-goal', description: 'exact scoped goal' },
    { name: '目标', definitionId: 'custom-chinese-goal', description: 'exact scoped Chinese goal' },
    { name: 'mission', definitionId: goal.definitionId, description: 'renamed native goal' },
  ]);
  expect(slashCommandFor(commands, '/goal')?.description).toBe('exact scoped goal');
  expect(slashCommandFor(commands, '/目标')?.description).toBe('exact scoped Chinese goal');
  expect(commands.find(command => command.name === '/mission')?.aliases).toBeUndefined();
  const renamedOnly = await catalog([{ name: 'mission', definitionId: goal.definitionId, description: 'renamed native goal' }]);
  expect(slashCommandFor(renamedOnly, '/goal')?.name).toBe('/mission');
  expect(slashCommandFor(renamedOnly, '/目标')?.name).toBe('/mission');
});

it('the captured baseline preview exposes the same identity-bound spellings', () => {
  const commands = dshCommandAliases(preview.commands);
  for (const descriptor of descriptors) expect(slashCommandFor(commands, `/${descriptor.alias}`)).toMatchObject({ definitionId: descriptor.definitionId });
});

it('the execution path forwards a Chinese line and every argument byte unchanged', async () => {
  const adapter = new DshAdapter();
  const client = {};
  const runtime = { nativeId: 'controlled-native' };
  const stub = adapter as unknown as { client: unknown; sessions: Map<string, unknown>; ensureSidecar(): Promise<unknown>; call(...args: unknown[]): Promise<unknown> };
  stub.client = client; stub.sessions.set('controlled', runtime);
  vi.spyOn(stub, 'ensureSidecar').mockResolvedValue(client);
  const call = vi.spyOn(stub, 'call').mockResolvedValue({ commandId: 'controlled-command', result: { kind: 'success', text: 'fixture receipt' } });
  const line = '/反馈\t  原始正文\r\nsecond  ';
  await adapter.executeSlashControl('controlled', line);
  expect(call).toHaveBeenCalledWith(client, 'commands/execute', { agentId: runtime.nativeId, line, submittedAttachments: [] }, 'controlled');
});

it('a same-named custom definition never acquires first-party aliases', async () => {
  const commands = await catalog([{ name: 'goal', definitionId: 'custom-goal', description: 'custom' }]);
  expect(slashCommandFor(commands, '/goal')).toBeDefined();
  expect(slashCommandFor(commands, '/目标')).toBeUndefined();
});

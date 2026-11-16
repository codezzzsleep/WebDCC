import type { SlashCommand } from '@webdcc/protocol';

/** Host0.2.2-rc.1 CommandDescriptor, including its plugin-owned identity. */
export interface DshCommandDescriptor {
  readonly definitionId?: string;
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint?: string; readonly attachments?: boolean };
}

// Frozen from interaction/commands/src/builtin.ts at fcc0ad462. Native aliases
// select their definition identity after exact scoped name resolution.
const spellings = new Map<string, string[]>([
  ['@deepseek-ai/dsh-command-goal', ['/goal', '/目标']],
  ['@deepseek-ai/dsh-plan-mode', ['/plan', '/计划']],
  ['@deepseek-ai/dsh-command-feedback', ['/feedback', '/反馈']],
  ['@deepseek-ai/dsh-command-compact', ['/compact', '/压缩']],
  ['@deepseek-ai/dsh-permission-presets', ['/permission', '/权限']],
  ['@deepseek-ai/dsh-session-log-export', ['/export', '/导出']],
]);

/** Advertise only spellings that resolve to this descriptor in the effective
 * catalog. Scoped exact names and the first matching definition keep priority. */
export function dshCommandAliases(commands: SlashCommand[]): SlashCommand[] {
  const exact = new Set(commands.map(command => command.name));
  const seen = new Set<string>();
  return commands.map(command => {
    const tokens = command.definitionId === undefined ? undefined : spellings.get(command.definitionId);
    if (tokens === undefined || seen.has(command.definitionId!)) return command;
    seen.add(command.definitionId!);
    const aliases = tokens.filter(token => !exact.has(token));
    return aliases.length === 0 ? command : { ...command, aliases };
  });
}

export function mapDshCommands(commands: DshCommandDescriptor[]): SlashCommand[] {
  return dshCommandAliases(commands.filter(command => typeof command.name === 'string').map(command => ({
    name: command.name.startsWith('/') ? command.name : `/${command.name}`,
    ...(typeof command.definitionId === 'string' ? { definitionId: command.definitionId } : {}),
    source: 'DSH commands/list', route: 'native-control', argumentHint: command.input?.hint,
    supportsAttachments: command.input?.attachments === true,
    ...(command.description === undefined ? {} : { description: command.description }),
  })));
}

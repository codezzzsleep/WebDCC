import type { SlashCommand } from '@webdcc/protocol';
import catalog from './slash-catalog.json' with { type: 'json' };

export function claudeSlashCommands(commands: SlashCommand[], terminalNames: string[]): SlashCommand[] {
  const slash = (name: string): string => name.startsWith('/') ? name : '/' + name;
  const terminals = new Set(terminalNames.map(slash));
  const native = commands.map(command => ({ ...command, name: slash(command.name), source: command.builtin === true ? 'Claude 原生 SDK 指令' : 'Claude 项目/插件指令',
    route: terminals.has(slash(command.name)) ? 'native-terminal' as const : 'native-input' as const,
    aliases: command.aliases?.map(slash) }));
  const known = new Set(native.flatMap(command => [command.name, ...command.aliases ?? []]));
  return [...native, ...catalog.commands.filter(command => !known.has(command.name)).map(command => ({ ...command,
    source: `Claude ${catalog.nativeVersion} 原生 CLI`, route: 'native-terminal' as const,
    reason: '在原生 CLI 执行；可用性由当前账号、平台与原生配置决定' }))];
}

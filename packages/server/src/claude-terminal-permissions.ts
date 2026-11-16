import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { nativeSurfaceError } from './native-surface.js';

const directModes = ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'] as const satisfies readonly PermissionMode[];
export type ClaudeTerminalPermissionMode = (typeof directModes)[number] | 'manual';

/** Fixed SDK/CLI permission contract; omission preserves the selected native profile. */
export function claudeTerminalPermissionMode(value: string | undefined, uid = process.getuid?.()): ClaudeTerminalPermissionMode | undefined {
  if (value === undefined || value === '' || value === 'inherit') return undefined;
  // SDK 0.3.322 calls this mode default; CLI 2.1.322 calls it manual.
  const mode = value === 'default' ? 'manual' : value;
  if (mode !== 'manual' && !directModes.some(candidate => candidate === mode)) throw nativeSurfaceError('此 SDK 权限模式尚未验证可用于原生 CLI；请使用结构化界面');
  if (mode === 'bypassPermissions' && uid === 0) throw nativeSurfaceError('原生 Claude CLI 不允许 root 使用 bypassPermissions', 400);
  return mode as ClaudeTerminalPermissionMode;
}

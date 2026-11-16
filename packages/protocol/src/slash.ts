import type { AgentId } from './adapter.js';
import type { InputContent, InputAttachmentPart } from './input.js';

export interface SlashCommand {
  name: string;
  /** Native plugin-owned identity, when supplied by the command catalog. */
  definitionId?: string;
  description?: string;
  source?: string;
  route?: 'native-input' | 'native-control' | 'native-terminal' | 'web';
  action?: string;
  aliases?: string[];
  argumentHint?: string;
  supportsAttachments?: boolean;
  availableDuringTurn?: boolean;
  available?: boolean;
  builtin?: boolean;
  reason?: string;
}
export interface SlashCommandCatalog {
  agent: AgentId;
  commands: SlashCommand[];
  status: 'ready' | 'empty' | 'error';
  revision: string;
  reason?: string;
  /** False for previews which cannot enumerate later session-scoped entries. */
  complete?: boolean;
}
export interface SlashCommandPreview {
  commands: SlashCommand[];
  reason?: string;
  complete?: boolean;
}
export interface SlashControlRequest {
  commandId: string;
  line: string;
  revision: string;
  /** A new explicit user decision after inspecting an existing native goal. */
  replaceGoal?: boolean;
  editGoal?: boolean;
  contentParts?: InputContent;
}
export interface SlashControlResult {
  text?: string;
  result?: unknown;
  form?: 'goal-edit' | 'goal-replace' | 'rename' | 'dsh-export';
  /** An acknowledged native action; credentials and arbitrary URLs never belong here. */
  download?: { kind: 'dsh-session-log'; nativeId: string };
  objective?: string;
  attachments?: InputAttachmentPart[];
  confirmed?: boolean;
  failed?: boolean;
}

/** Preserve separator whitespace and every argument byte. A slash elsewhere
 * in ordinary text is not a command. Native handlers own argument grammar. */
export function parseSlashInput(text: string): { name: string; rawArguments: string; line: string } | undefined {
  const match = /^\/([^\s/]+)(?=\s|$)/u.exec(text);
  return match === null ? undefined : { name: `/${match[1]}`, rawArguments: text.slice(match[0].length), line: text };
}

export function slashCommandFor(commands: SlashCommand[], text: string): SlashCommand | undefined {
  const parsed = parseSlashInput(text);
  if (parsed === undefined) return undefined;
  const exact = commands.filter(command => command.name === parsed.name);
  return exact.find(command => command.builtin === true) ?? exact[0] ?? commands.find(command => command.aliases?.includes(parsed.name));
}

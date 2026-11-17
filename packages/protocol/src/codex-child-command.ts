import type { EventData } from './events.js';

/** A passive child command observation, independent of a Web or child turn end. */
export interface CodexSubagentCommand {
  nativeTurnId: string;
  itemId: string;
  /** Full original item; absent when an output delta preceded its metadata. */
  native?: Record<string, unknown>;
  output?: string;
  /** Captured progress remains available if the final aggregate differs. */
  streamedOutput?: string;
  /** No item/completed was observed for this command. */
  incomplete?: boolean;
}

export function validCodexCommandItem(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ['type', 'id', 'command', 'cwd', 'status', 'commandActions'].every(key => Object.hasOwn(item, key))
    && item['type'] === 'commandExecution' && typeof item['id'] === 'string' && item['id'] !== ''
    && typeof item['command'] === 'string' && typeof item['cwd'] === 'string' && typeof item['status'] === 'string'
    && Array.isArray(item['commandActions']);
}

/** Read the original native status, never infer success from an exit or turn. */
export function codexSubagentCommandStatus(command: CodexSubagentCommand): EventData['tool.call']['status'] {
  switch (command.native?.['status']) {
    case 'inProgress': return 'running';
    case 'completed': return 'completed';
    case 'failed':
    case 'declined': return 'failed';
    default: return 'unknown';
  }
}

export function observeCodexSubagentCommand(
  commands: readonly CodexSubagentCommand[],
  turns: Readonly<Record<string, { status: string }>>,
  value: unknown,
  phase: 'started' | 'delta' | 'completed',
): readonly CodexSubagentCommand[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return commands;
  const input = value as { nativeTurnId?: unknown; itemId?: unknown; native?: unknown; text?: unknown };
  if (typeof input.nativeTurnId !== 'string' || input.nativeTurnId === '' || typeof input.itemId !== 'string' || input.itemId === '') return commands;
  if (phase === 'delta' ? typeof input.text !== 'string'
    : !validCodexCommandItem(input.native) || input.native['id'] !== input.itemId) return commands;
  const previous = commands.find(command => command.nativeTurnId === input.nativeTurnId && command.itemId === input.itemId);
  if (previous !== undefined && previous.incomplete !== true) return commands;
  const turn = turns[input.nativeTurnId];
  if (phase !== 'completed' && turn !== undefined && turn.status !== 'inProgress') return commands;
  const next: CodexSubagentCommand = { ...previous, nativeTurnId: input.nativeTurnId, itemId: input.itemId };
  if (phase === 'delta') {
    next.streamedOutput = (previous?.streamedOutput ?? previous?.output ?? '') + input.text;
    next.output = next.streamedOutput;
    next.incomplete = true;
  } else {
    const native = input.native as Record<string, unknown>;
    if (phase === 'completed') {
      next.native = native;
      if (typeof native['aggregatedOutput'] === 'string') next.output = native['aggregatedOutput'];
      delete next.incomplete;
    } else {
      next.native ??= native;
      if (previous === undefined && typeof native['aggregatedOutput'] === 'string') {
        next.output = native['aggregatedOutput']; next.streamedOutput = native['aggregatedOutput'];
      }
      next.incomplete = true;
    }
  }
  return commands.filter(command => command.nativeTurnId !== next.nativeTurnId || command.itemId !== next.itemId).concat(next);
}

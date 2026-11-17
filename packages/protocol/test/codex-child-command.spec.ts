import { expect, it } from 'vitest';
import { codexSubagentCommandStatus, observeCodexSubagentCommand, type CodexSubagentCommand } from '../src/index.js';

const native = { type: 'commandExecution', id: 'original:item', command: 'native command', cwd: '/native/workspace',
  status: 'inProgress', commandActions: [], processId: null, aggregatedOutput: null, exitCode: null };
const packet = { nativeTurnId: 'original:turn', itemId: 'original:item', native };

it('reads opaque future status honestly even after a parent turn and zero exit, with immutable native bytes and captured output', () => {
  const future = { ...native, status: 'future-native-state', exitCode: 0 };
  Object.freeze(future);
  const progress = observeCodexSubagentCommand([], {}, { ...packet, text: '原生🐈\r\n' }, 'delta');
  const result = observeCodexSubagentCommand(progress, { 'original:turn': { status: 'completed' } }, { ...packet, native: future }, 'completed');
  expect(result).toEqual([{ nativeTurnId: 'original:turn', itemId: 'original:item', native: future,
    output: '原生🐈\r\n', streamedOutput: '原生🐈\r\n' }]);
  expect(codexSubagentCommandStatus(result[0]!)).toBe('unknown');
  expect(codexSubagentCommandStatus(progress[0]!)).toBe('unknown');
  expect(future).toMatchObject({ status: 'future-native-state', exitCode: 0, aggregatedOutput: null });
});

it.each([
  { ...packet, nativeTurnId: '' }, { ...packet, itemId: '' }, { ...packet, native: { ...native, id: 'mismatched' } },
  { ...packet, native: { ...native, type: 'ordinary-tool' } }, { ...packet, native: { ...native, cwd: null } },
  { ...packet, native: { ...native, commandActions: null } }, { ...packet, native: { ...native, status: 1 } },
  null, [],
])('keeps unsupported command observation outside the known child view: %j', invalid => {
  const commands: CodexSubagentCommand[] = [];
  Object.freeze(commands);
  expect(observeCodexSubagentCommand(commands, {}, invalid, 'completed')).toBe(commands);
});

it('terminal fences preserve original arrays and items while a delayed real completion can settle a terminal partial command', () => {
  const partial: CodexSubagentCommand = { nativeTurnId: 'original:turn', itemId: 'original:item', native,
    output: 'known prefix', streamedOutput: 'known prefix', incomplete: true };
  const commands = [partial]; Object.freeze(commands); Object.freeze(partial); Object.freeze(native);
  const turns = { 'original:turn': { status: 'interrupted' } };
  expect(observeCodexSubagentCommand(commands, turns, { ...packet, text: 'late' }, 'delta')).toBe(commands);
  expect(observeCodexSubagentCommand(commands, turns, packet, 'started')).toBe(commands);
  const result = observeCodexSubagentCommand(commands, turns, { ...packet, native: { ...native, status: 'declined', aggregatedOutput: '' } }, 'completed');
  expect(result).toEqual([{ nativeTurnId: 'original:turn', itemId: 'original:item', native: { ...native, status: 'declined', aggregatedOutput: '' },
    output: '', streamedOutput: 'known prefix' }]);
  expect(codexSubagentCommandStatus(result[0]!)).toBe('failed');
  expect(observeCodexSubagentCommand(result, {}, { ...packet, text: 'late' }, 'delta')).toBe(result);
  expect(commands).toEqual([partial]); expect(partial.incomplete).toBe(true);
});

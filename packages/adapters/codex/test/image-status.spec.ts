import { expect, it } from 'vitest';
import type { EventData } from '@webdcc/protocol';
import { CodexAdapter, mapItemData } from '../src/adapter.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';

const nativeImage = (status: string): ThreadItem => ({ type: 'imageGeneration', id: 'image:string:🐈', status,
  result: '', revisedPrompt: null, generationId: null,
  failure: status === 'failed' ? { type: 'usageLimitExceeded', limitId: 'native:limit', resetsAt: null } : null });

it.each([['in_progress', 'running'], ['completed', 'completed'], ['failed', 'failed'], ['', 'unknown'], ['future-native-status', 'unknown']])(
  'uses the official native imageGeneration status %s without guessing from results', (status, expected) => {
    const original = nativeImage(status); Object.freeze(original);
    expect(mapItemData(original as unknown as Record<string, unknown>)).toEqual({ name: 'imageGeneration', input: original, status: expected });
  });

it('preserves original in-progress and failed image items, native call/turn IDs and quota failure', () => {
  const replay = CodexAdapter.replay('session', 'parent');
  replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'native:turn', status: 'inProgress' } } } });
  const begin = nativeImage('in_progress');
  const started = replay.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame: { method: 'item/started', params: { threadId: 'parent', turnId: 'native:turn', startedAtMs: 1, item: begin } } });
  expect(started).toContainEqual(expect.objectContaining({ type: 'item.start', kind: 'tool.call', itemKey: begin.id, nativeTurnId: 'native:turn',
    data: { name: 'imageGeneration', input: begin, status: 'running' }, native: begin }));
  const final = nativeImage('failed');
  const completed = replay.feed({ i: 3, t: 3, dir: 'in', ch: 'rpc', frame: { method: 'item/completed', params: { threadId: 'parent', turnId: 'native:turn', completedAtMs: 2, item: final } } });
  expect(completed).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'tool.call', itemKey: final.id, nativeTurnId: 'native:turn',
    data: { name: 'imageGeneration', input: final, status: 'failed' }, native: final }));
});

it('retains file-backed generation identity, path, local inputs, transparent flag and revised prompt', () => {
  const original = { type: 'imageGeneration', id: 'image:file', status: 'completed', fileId: 'native:file:id', savedPath: '/native/result.png',
    revisedPrompt: ' 原始提示\r\n🐈', generationId: 'native:generation', transparentBackground: true, failure: null,
    inputImages: [{ path: '/native/input.png', sha256: 'a'.repeat(64), extraNativeField: 'unchanged' }] };
  expect(mapItemData(original) as EventData['tool.call']).toEqual({ name: 'imageGeneration', input: original, status: 'completed' });
});

it.each([undefined, null, false, 42])('does not fabricate completion from missing or unsupported imageGeneration status %s', status => {
  const original = { ...nativeImage('completed'), status };
  expect(mapItemData(original)).toMatchObject({ input: original, status: 'unknown' });
});

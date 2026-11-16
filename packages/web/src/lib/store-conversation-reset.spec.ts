import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerMessage, StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[] }));
vi.mock('./connection.js', () => ({ SyncConnection: class { constructor(options: SyncConnectionOptions) { mocks.options.push(options); } subscribe = vi.fn(); unsubscribe = vi.fn(); } }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }) } }));
vi.mock('./db.js', () => ({ cache: { putEvents: vi.fn().mockResolvedValue(undefined), putSession: vi.fn().mockResolvedValue(undefined), setMeta: vi.fn().mockResolvedValue(undefined) } }));
import { AppStore } from './store.js';

beforeEach(() => { vi.useFakeTimers(); mocks.options.length = 0; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const event = (seq: number, kind: StoredEvent['kind'], data: StoredEvent['data'], turnId: string | null = 'one'): StoredEvent => ({
  sessionId: 's', seq, kind, data, turnId, itemKey: `item-${seq}`, at: new Date(seq).toISOString() });
const reset = event(3, 'notice', { level: 'info', text: '已开始新的对话', nativeType: 'conversation_reset', contextReset: { id: 'next', uuid: 'reset' } }, null);

it('separates prior records from current output, keeps history read-only and does not wipe twice when feed precedes the event', async () => {
  const store = new AppStore();
  const feed = (message: ServerMessage) => mocks.options.at(-1)!.onMessage(message);
  feed({ op: 'feed', feedSeq: 1, sessionId: 's', patch: { title: 'Previous title', agent: 'claude-code', nativeId: 'old', workspaceId: 'w' } });
  store.applyEvent(event(1, 'user.message', { text: 'previous input' }));
  store.applyEvent(event(2, 'assistant.message', { text: 'previous answer' }));
  feed({ op: 'feed', feedSeq: 2, sessionId: 's', patch: { title: null, conversation: { id: 'next', uuid: 'reset', resetSeq: 3, previousTitle: 'Previous title', previousNativeId: 'old' } } });
  feed({ op: 'update', sessionId: 's', turnId: 'one', itemKey: 'new-live', data: { started: true, kind: 'reasoning', data: { text: 'new live output' } } });
  store.applyEvent(reset);
  expect(store.getHot('s')).toHaveLength(1);
  expect(store.getSession('s')?.title).toBeUndefined();
  expect(store.getConversationEvents('s')).toEqual([]);
  store.applyEvent(event(4, 'assistant.message', { text: 'new output after plan-mode reset' }));
  store.applyEvent(event(5, 'turn.completed', { status: 'completed', durationMs: 1, answerItemKeys: ['item-4'] }));
  expect(store.getConversationEvents('s').map(row => row.seq)).toEqual([4, 5]);
  expect(store.getConversationEvents('s', true).map(row => row.seq)).toEqual([1, 2]);
  expect(store.getEvents('s')).toHaveLength(5);
  store.viewConversationHistory('s', true);
  await expect(store.sendStructuredMessage('s', 'must not send', { version: 1, parts: [{ type: 'text', text: 'must not send' }] })).rejects.toThrow('返回当前对话');
  store.viewConversationHistory('s', false);
  expect(store.getTurns('s').some(turn => turn.answer.some(answer => answer.text === 'new output after plan-mode reset'))).toBe(true);
});

it('ignores earlier boundary events and stale metadata during refresh replay', () => {
  const store = new AppStore();
  const feed = (message: ServerMessage) => mocks.options.at(-1)!.onMessage(message);
  feed({ op: 'feed', feedSeq: 5, sessionId: 's', patch: { title: 'Current renamed title', conversation: { id: 'latest', uuid: 'latest-reset', resetSeq: 10 } } });
  store.applyEvent(reset, true);
  feed({ op: 'feed', feedSeq: 4, sessionId: 's', patch: { title: 'Old cached title', conversation: { id: 'next', uuid: 'reset', resetSeq: 3 } } });
  expect(store.getSession('s')?.title).toBe('Current renamed title');
  expect(store.getSession('s')?.conversation?.id).toBe('latest');
});

it('keeps a late resolution of a prior question in its historical transcript', () => {
  const store = new AppStore();
  const feed = (message: ServerMessage) => mocks.options.at(-1)!.onMessage(message);
  feed({ op: 'feed', feedSeq: 1, sessionId: 's', patch: { agent: 'claude-code' } });
  const question = { questionId: 'previous-question', groupId: 'previous-request', prompt: 'prior context question', status: 'pending' as const };
  store.applyEvent(event(1, 'question', question));
  store.applyEvent(reset);
  store.applyEvent(event(4, 'question', { ...question, status: 'skipped', resolution: 'outcome-unknown' }));
  expect(store.getConversationEvents('s')).toEqual([]);
  expect(store.getConversationEvents('s', true).filter(row => row.kind === 'question')).toHaveLength(2);
  expect(store.getEvents('s')).toHaveLength(3);
  store.applyEvent(event(5, 'question', { ...question, groupId: 'new-native-request' }));
  expect(store.getConversationEvents('s').map(row => row.seq)).toEqual([5]);
});

import { afterEach, expect, it, vi } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { currentClaudeTasks, currentClaudeTaskViews, type AdapterEvent, type StoredEvent } from '@webdcc/protocol';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../src/adapter.js';

const adapters = new Set<ClaudeAdapter>();
const sessionId = 'runtime-contract';
function harness() {
  let closed = false;
  let wake: (() => void) | undefined;
  const queue: SDKMessage[] = [];
  const events: AdapterEvent[] = [];
  const query = {
    async *[Symbol.asyncIterator]() {
      while (!closed || queue.length) {
        const message = queue.shift();
        if (message !== undefined) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    },
    close: vi.fn(() => { closed = true; wake?.(); }),
  };
  mocked.query.mockImplementationOnce(() => query as unknown as Query);
  const adapter = new ClaudeAdapter();
  adapters.add(adapter);
  adapter.onEvent((_id, event) => events.push(event));
  return { adapter, events, query, push(subtype: string, fields: Record<string, unknown> = {}) {
    queue.push({ type: 'system', subtype, session_id: 'native', uuid: `controlled-${events.length}-${subtype}`, ...fields } as unknown as SDKMessage);
    wake?.();
  } };
}
function stored(events: readonly AdapterEvent[]): StoredEvent[] {
  return events.flatMap((event, seq) => event.type === 'item.complete' ? [{ sessionId, seq, turnId: null, itemKey: event.itemKey,
    at: new Date(seq).toISOString(), kind: event.kind, data: event.data, native: event.native } as StoredEvent] : []);
}
const active = (task_id: string) => ({ task_id, run_id: '002', description: task_id, is_backgrounded: true });
afterEach(async () => {
  await Promise.all([...adapters].map(adapter => adapter.dispose(sessionId)));
  adapters.clear(); mocked.query.mockReset();
});

it('keeps concurrent running, paused and terminal tasks through repeated init in one actual query', async () => {
  const h = harness();
  await h.adapter.create({ sessionId, cwd: '/tmp', providerId: null });
  h.push('init', { model: 'controlled-model', cwd: '/tmp' });
  h.push('task_started', active('sibling'));
  h.push('task_started', active('paused'));
  h.push('task_updated', { task_id: 'paused', run_id: '002', patch: { status: 'paused' } });
  h.push('task_notification', { task_id: 'first', run_id: '002', status: 'stopped', summary: 'stopped', output_file: '/tmp/first' });
  h.push('background_tasks_changed', { tasks: ['sibling', 'paused'].map(task_id => ({ task_id, run_id: '002', task_type: 'local_agent', description: task_id })) });
  await vi.waitFor(() => expect(h.adapter.nativeState(sessionId).tasks.find(task => task.taskId === 'paused')?.backgroundPresence).toBe('present'));
  h.push('init', { model: 'controlled-model', cwd: '/tmp' });
  await vi.waitFor(() => expect(h.events.filter(event => 'native' in event && (event.native as { subtype?: string } | undefined)?.subtype === 'init')).toHaveLength(2));
  const tasks = h.adapter.nativeState(sessionId).tasks;
  expect(tasks.find(task => task.taskId === 'sibling')).toMatchObject({ status: 'running', backgroundPresence: 'present' });
  expect(tasks.find(task => task.taskId === 'paused')).toMatchObject({ status: 'paused', backgroundPresence: 'present' });
  expect(tasks.find(task => task.taskId === 'first')).toMatchObject({ status: 'stopped', terminalNotification: 'stopped' });
  expect(currentClaudeTasks(stored(h.events))).toEqual(tasks);
  expect(currentClaudeTaskViews(stored(h.events)).tasks.find(task => task.taskId === 'sibling')?.status).toBe('running');
});

it('keeps persisted active tasks unknown after the query stream actually closes', async () => {
  const h = harness();
  await h.adapter.create({ sessionId, cwd: '/tmp', providerId: null });
  h.push('init', { model: 'controlled-model', cwd: '/tmp' });
  h.push('task_started', active('sibling'));
  h.push('task_notification', { task_id: 'done', run_id: '002', status: 'completed', summary: 'done', output_file: '/tmp/done' });
  await vi.waitFor(() => expect(h.adapter.nativeState(sessionId).tasks).toHaveLength(2));
  h.query.close();
  await vi.waitFor(() => expect(h.events.some(event => event.type === 'transport.closed')).toBe(true));
  const tasks = currentClaudeTasks(stored(h.events));
  expect(tasks.find(task => task.taskId === 'sibling')).toMatchObject({ status: 'unknown', nativeStatus: 'running', backgroundPresence: 'unknown' });
  expect(tasks.find(task => task.taskId === 'done')).toMatchObject({ status: 'completed', summary: 'done' });
});

it('persists a distinct query boundary across an adapter restart before any resumed native init', async () => {
  const first = harness();
  await first.adapter.create({ sessionId, cwd: '/tmp', providerId: null });
  first.push('init', { model: 'controlled-model', cwd: '/tmp' });
  first.push('task_started', active('sibling'));
  await vi.waitFor(() => expect(first.adapter.nativeState(sessionId).tasks).toHaveLength(1));
  const priorEvents = stored(first.events);
  await first.adapter.dispose(sessionId);
  const second = harness();
  await second.adapter.create({ sessionId, cwd: '/tmp', providerId: null });
  const recovered = currentClaudeTasks([...priorEvents, ...stored(second.events)]);
  expect(recovered[0]).toMatchObject({ taskId: 'sibling', status: 'unknown', nativeStatus: 'running', backgroundPresence: 'unknown' });
});

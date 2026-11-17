/** Controlled native question group/transport through production manager and store. */
import type { TestApp } from '../helpers.js';
import type { DshHostClient } from '../../../adapters/dsh/src/host.js';
import { bindDshQuestionFixture } from './dsh-question.js';
import type { SessionDto } from '@webdcc/protocol';
import { DshAdapter } from '../../../adapters/dsh/src/adapter.js';
import { bindDshSubagentFixture } from '../../../adapters/dsh/test/subagent-fixture.js';

export function bindDshQuestionOriginalRetry(ctx: Pick<TestApp, 'store' | 'manager' | 'dataDir'>, options: { secret?: boolean; timed?: boolean; existing?: SessionDto } = {}) {
  const base = options.existing === undefined ? bindDshQuestionFixture(ctx) : (() => {
    const session = options.existing!; const native = DshAdapter.replay(session.id, session.nativeId!);
    native.adapter.listAccessModes = async () => [{ id: 'inherit', label: '原生默认', allowed: true }];
    bindDshSubagentFixture(ctx.manager, session, ctx.store.getWorkspace(session.workspaceId)!.path, native.adapter, session.nativeId!);
    const feed = (value: unknown) => native.feed({ i: 0, t: 0, dir: 'in', ch: 'mux:$events', frame: { type: 'item', value } });
    feed({ type: 'ready', clientId: 'reopened-native-client' }); return { session, native, feed };
  })(); const { native, feed } = base;
  native.adapter.hostIdentity = async () => ({ url: 'http://native.test/dsh/', status: 'verified', source: 'native-bootstrap', version: '0.2.2-rc.1',
    fingerprint: 'e'.repeat(64), profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' } });
  native.adapter.nativeCatalog = async () => ({});
  const eventId = 'original-question-waterfall'; const callId = 'original-question-call';
  const questions = [{ id: 'one', question: 'Original first choice', options: [{ label: 'Keep' }], ...(options.secret ? { isSecret: true } : {}) },
    { id: 'two', question: 'Original second choice', options: [{ label: 'Second' }], multiSelect: true }];
  let seq = 0;
  const record = (type: string, data: unknown) => feed({ type: 'event', event: { type, seq: ++seq, time: Date.now(), data } });
  record('tool/call', { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) });
  const ask = (override: { agentId?: string; eventId?: string; callId?: string; questions?: Record<string, unknown>[] } = {}) => feed({ type: 'waterfall', event: 'user-questions/request',
    agentId: override.agentId ?? 'native-question-root', eventId: override.eventId ?? eventId, request: { questions: override.questions ?? questions,
      ...(options.timed || override.callId !== undefined ? { wait: { callId: override.callId ?? callId, timed: options.timed === true } } : {}) } });
  ask();
  const client = (native.adapter as unknown as { client: DshHostClient }).client; const rpc = client.rpc.bind(client);
  const replies: Record<string, unknown>[] = [];
  client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
    if (endpoint !== '$events/result') return rpc<T>(endpoint, args);
    replies.push(args);
    if (replies.length === 1) throw Object.assign(new Error('controlled original group reply transport loss'), { code: 'uncertain' });
    return undefined as T;
  };
  const reoffer = () => { feed({ type: 'ready', clientId: 'replacement-question-client' }); ask(); };
  return { ...base, record, eventId, callId, questions, ask, reoffer, replies, client, ids: questions.map(question => `${eventId}:${question.id}`) };
}

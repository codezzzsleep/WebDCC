/** Controlled native frames through production adapter/manager/UI; no Host or model execution. */
import { DshAdapter } from '../../../adapters/dsh/src/adapter.js';
import { bindDshSubagentFixture } from '../../../adapters/dsh/test/subagent-fixture.js';
import type { TestApp } from '../helpers.js';

export function bindDshQuestionFixture(ctx: Pick<TestApp, 'store' | 'manager' | 'dataDir'>) {
  const workspace = ctx.store.createWorkspace('Native question recovery', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh', accessMode: 'inherit' });
  const nativeId = 'native-question-root'; ctx.store.updateSession(session.id, { nativeId });
  const native = DshAdapter.replay(session.id, nativeId);
  native.adapter.listAccessModes = async () => [{ id: 'inherit', label: '原生默认', allowed: true }];
  bindDshSubagentFixture(ctx.manager, ctx.store.getSession(session.id)!, workspace.path, native.adapter, nativeId);
  let sequence = 0;
  const feed = (value: unknown) => native.feed({ i: sequence, t: sequence, dir: 'in', ch: 'mux:$events', frame: { type: 'item', value } });
  const record = (type: string, data: unknown) => feed({ type: 'event', event: { type, seq: ++sequence, time: Date.now(), data } });
  feed({ type: 'ready', clientId: 'current-client' });
  const ask = (callId = 'native-question-call', eventId = 'native-question-waterfall') => {
    const questions = [{ id: 'one', question: 'Choose the native result', options: [{ label: 'Continue' }, { label: 'Stop' }] }];
    record('tool/call', { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) });
    feed({ type: 'waterfall', event: 'user-questions/request', eventId, agentId: nativeId, request: { questions } });
    return `${eventId}:one`;
  };
  const result = (selected: string[], callId = 'native-question-call') => record('tool/result', { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'one', selected }] }) }], isError: false } });
  return { native, session, ask, result, feed };
}

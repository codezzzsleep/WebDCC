/** Controlled native delivery and RPC failure; production manager/HTTP and no Host/model. */
import type { DshHostClient } from '../../../adapters/dsh/src/host.js';
import type { TestApp } from '../helpers.js';
import { bindDshQuestionFixture } from './dsh-question.js';

export function bindDshApprovalRetry(ctx: Pick<TestApp, 'store' | 'manager' | 'dataDir'>) {
  const base = bindDshQuestionFixture(ctx); const { native, feed } = base;
  native.adapter.hostIdentity = async () => ({ url: 'http://native.test/dsh/', status: 'verified', source: 'native-bootstrap',
    version: '0.2.2-rc.1', fingerprint: 'controlled-approval-host', profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' } });
  native.adapter.nativeCatalog = async () => ({});
  let seq = 0;
  const record = (type: string, data: unknown) => feed({ type: 'event', event: { type, seq: ++seq, time: Date.now(), data } });
  record('turn/start', { turn: 1 });
  record('approval/asked', { id: 'durable-approval', callId: 'approval-call', toolName: 'write' });
  const ask = () => feed({ type: 'waterfall', event: 'approval/request', agentId: 'native-question-root', eventId: 'approval-event',
    request: { callId: 'approval-call', toolName: 'write', reason: 'Original approval reply recovery' } });
  ask(); const client = (native.adapter as unknown as { client: DshHostClient }).client;
  const rpc = client.rpc; const replies: Record<string, unknown>[] = [];
  client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
    if (endpoint !== '$events/result') return rpc<T>(endpoint, args);
    replies.push(args);
    if (replies.length === 1) throw Object.assign(new Error('first native approval reply transport failed'), { code: 'uncertain' });
    return undefined as T;
  };
  const reoffer = () => { feed({ type: 'ready', clientId: 'replacement-client' }); ask(); };
  return { ...base, record, ask, reoffer, replies, client, approvalId: 'approval-event' };
}

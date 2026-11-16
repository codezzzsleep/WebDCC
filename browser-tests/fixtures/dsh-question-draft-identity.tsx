/** Controlled cached events/late feed metadata; actual Source Timeline and draft store. */
import { createRoot } from 'react-dom/client';
import type { DshQuestionIdentity, StoredEvent } from '@webdcc/protocol';
import { Timeline } from '../../packages/web/src/components/Timeline.js';
import { store, type SessionMeta } from '../../packages/web/src/lib/store.js';

const sessionId = 'controlled-draft-session';
const identity: DshQuestionIdentity = { nativeId: 'controlled-native-root', callId: 'controlled-call', itemId: 'one',
  clientId: 'controlled-client', timed: true, phase: 'open' };
const secret = new URLSearchParams(location.search).has('secret');
let session: SessionMeta | undefined;
let question: StoredEvent<'question'> = { sessionId, seq: 1, turnId: null, itemKey: 'controlled-question', at: '2026-11-16T00:00:00Z', kind: 'question',
  data: { questionId: 'controlled-waterfall:one', prompt: 'Restore this native draft', options: [{ id: 'Continue', label: 'Continue' }],
    allowsFreeText: true, isSecret: secret, dshQuestion: identity } };
store.getSession = () => session;
store.getTurns = () => [];
store.getEvents = () => [question];
store.getConversationEvents = () => [question];
store.getHot = () => [];
store.isViewingConversationHistory = () => false;
store.isInteractionSynced = () => session !== undefined;
store.dshQuestionWaits.drafts.save(sessionId, identity, 'editing', { selected: ['Continue'], custom: 'saved original draft' });
const changed = () => (store as unknown as { notify(): void }).notify();
declare global { interface Window { draftFixture: { publishSession(): void; continueQuestion(): void; duplicateDelivery(): void } } }
window.draftFixture = {
  publishSession() {
    session = { id: sessionId, workspaceId: 'controlled-workspace', agent: 'dsh', nativeId: identity.nativeId,
      status: 'waiting', updatedAt: '2026-11-16T00:00:00Z' };
    changed();
  },
  continueQuestion() {
    question = { ...question, seq: question.seq + 1, data: { ...question.data, dshQuestion: { ...identity, phase: 'continued' } } };
    changed();
  },
  duplicateDelivery() {
    question = { ...question, seq: question.seq + 1, data: { ...question.data, dshQuestion: { ...question.data.dshQuestion!, clientId: 'replacement-controlled-client' } } };
    changed();
  },
};
createRoot(document.getElementById('root')!).render(<Timeline sessionId={sessionId} onOpenDiff={() => undefined} onHandoff={() => undefined} />);

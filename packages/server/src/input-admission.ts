import type { FeedPatch, QueuedInput, RuntimeIdentity, StoredEvent, UserInput } from '@webdcc/protocol';
import { publicInputContent } from '@webdcc/protocol';
import type { Db } from './db.js';
import type { Store } from './store.js';

export interface QueueChange { patch: FeedPatch; feedSeq: number }

export function inputNotSubmitted(error: unknown): Error {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), { nativeAdmission: 'not-submitted' as const });
}

/** Persist the admission boundary before publishing it or invoking native. */
export class InputAdmissionStore {
  constructor(private readonly db: Db, private readonly store: Store) {}

  enqueue(commandId: string, sessionId: string, turnId: string, input: UserInput): QueueChange & { accepted: QueuedInput } {
    try {
      return this.db.transaction(() => {
        const accepted = this.store.journal.enqueue(commandId, sessionId, turnId, input);
        const patch = { queueRevision: Date.now() };
        return { accepted, patch, feedSeq: this.store.appendFeed(sessionId, patch) };
      }).immediate();
    } catch (error) { throw inputNotSubmitted(error); }
  }

  begin(sessionId: string, turnId: string, input: UserInput, identity: RuntimeIdentity, commandId?: string, title?: string): QueueChange & { events: StoredEvent[]; titleChange?: QueueChange } {
    try {
      return this.db.transaction(() => {
        this.store.nativeOwners.assert(sessionId, identity);
        if (!this.store.journal.beginInput(turnId)) throw Object.assign(new Error('队列输入已被取消或占有'), { statusCode: 409 });
        const user = this.store.appendEvent({ sessionId, turnId, itemKey: `user-${turnId}`, kind: 'user.message', data: {
          text: input.text, intent: input.delivery ?? 'send',
          ...(commandId === undefined ? {} : { clientCommandId: commandId }),
          ...(input.images === undefined ? {} : { images: input.images.map(image => image.fileId) }),
          ...(input.contentParts === undefined ? {} : { contentParts: publicInputContent(input.contentParts) }),
        } });
        const started = this.store.appendEvent({ sessionId, turnId, itemKey: `turn-start-${turnId}`, kind: 'turn.started', data: {} });
        const patch = { queueRevision: Date.now() };
        const feedSeq = this.store.appendFeed(sessionId, patch);
        const session = this.store.getSession(sessionId)!;
        let titleChange: QueueChange | undefined;
        if (title !== undefined && !session.title) {
          this.store.setTitleSource(sessionId, 'user');
          titleChange = { patch: { title }, feedSeq: this.store.updateSessionAndFeed(sessionId, { title }, { title }).feedSeq };
        }
        return { events: [user, started], patch, feedSeq, ...(titleChange === undefined ? {} : { titleChange }) };
      }).immediate();
    } catch (error) { throw inputNotSubmitted(error); }
  }
}

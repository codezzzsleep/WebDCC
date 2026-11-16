import type { DshQuestionIdentity, DshQuestionWaitRequest, DshQuestionWaitMessage } from '@webdcc/protocol';
import { DshQuestionWaitCard } from './dsh-question-wait.js';
import { DshQuestionDrafts } from './dsh-question-drafts.js';

export interface DshWaitEntry {
  card: DshQuestionWaitCard;
  sessionId: string;
  questionId: string;
  identity: DshQuestionIdentity;
  attempted: boolean;
  hidden: boolean;
  requestId?: string;
  claimId?: string;
  error?: string;
}

/** Cards outlive their panels. Native claims belong to this browser socket. */
export class DshQuestionWaits {
  readonly drafts = new DshQuestionDrafts();
  private readonly entries = new Map<string, DshWaitEntry>();
  private readonly requests = new Map<string, DshWaitEntry>();
  constructor(private readonly send: (message: DshQuestionWaitRequest) => void, private readonly changed: () => void) {}
  private key(sessionId: string, identity: DshQuestionIdentity): string { return JSON.stringify([sessionId, identity.nativeId, identity.callId]); }
  private waterfall(questionId: string, identity: DshQuestionIdentity): string { return questionId.slice(0, -identity.itemId.length - 1); }

  ensure(sessionId: string, questionId: string, identity: DshQuestionIdentity, canClaim: boolean): DshWaitEntry {
    const key = this.key(sessionId, identity);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { card: new DshQuestionWaitCard(this.changed), sessionId, questionId, identity, attempted: false, hidden: false };
      this.entries.set(key, entry);
      const wait = this.drafts.wait(sessionId, identity);
      if (wait === 'waiting') entry.card.takeTime();
      else if (wait === 'editing') entry.card.engage();
    } else if ((this.waterfall(entry.questionId, entry.identity) !== this.waterfall(questionId, identity) || entry.identity.clientId !== identity.clientId)
      && identity.phase === 'open' && entry.card.snapshot().phase === 'open') {
      this.release(entry); entry.questionId = questionId; entry.identity = identity; entry.attempted = false;
    }
    if (identity.phase === 'continued' && entry.card.snapshot().phase !== 'continued') {
      this.release(entry); entry.identity = identity; entry.questionId = questionId;
      entry.error = undefined; entry.card.continue();
    }
    if (identity.timed && identity.phase === 'open' && canClaim && !entry.attempted && entry.card.snapshot().phase === 'open') this.claim(entry);
    return entry;
  }
  get(sessionId: string, identity: DshQuestionIdentity): DshWaitEntry | undefined { return this.entries.get(this.key(sessionId, identity)); }
  toggleSurface(entry: DshWaitEntry): void { entry.card.releaseFocus(); entry.hidden = !entry.hidden; this.changed(); }
  private claim(entry: DshWaitEntry): void {
    const requestId = crypto.randomUUID(); entry.attempted = true; entry.error = undefined; entry.requestId = requestId;
    this.requests.set(requestId, entry);
    this.send({ op: 'dsh-question-wait', requestId, sessionId: entry.sessionId, questionId: entry.questionId, action: 'claim' });
    this.changed();
  }
  retry(entry: DshWaitEntry): void {
    this.release(entry); entry.attempted = false;
    if (entry.card.snapshot().phase === 'open') this.claim(entry);
  }
  release(entry: DshWaitEntry): void {
    if (entry.claimId !== undefined) this.send({ op: 'dsh-question-wait', requestId: crypto.randomUUID(), sessionId: entry.sessionId, questionId: entry.questionId, action: 'release', claimId: entry.claimId });
    for (const [id, owner] of this.requests) if (owner === entry) this.requests.delete(id);
    entry.claimId = undefined; entry.requestId = undefined; entry.card.detach();
  }
  finish(sessionId: string, identity: DshQuestionIdentity): void {
    this.drafts.clear(sessionId, identity);
    const entry = this.entries.get(this.key(sessionId, identity));
    if (entry !== undefined) { this.release(entry); entry.card.close(); }
  }
  disconnect(sessionId?: string): void {
    for (const entry of this.entries.values()) if (sessionId === undefined || entry.sessionId === sessionId) {
      for (const [id, owner] of this.requests) if (owner === entry) this.requests.delete(id);
      entry.claimId = undefined; entry.requestId = undefined; entry.attempted = false; entry.card.detach();
    }
  }
  message(message: DshQuestionWaitMessage): void {
    const entry = this.requests.get(message.requestId);
    if (entry === undefined || message.sessionId !== entry.sessionId || message.questionId !== entry.questionId) return;
    const result = message.result;
    if (result.kind === 'claim') {
      if (message.requestId !== entry.requestId || result.callId !== entry.identity.callId || !Number.isSafeInteger(result.remainingMs) || result.remainingMs < 0) return;
      entry.claimId = result.claimId;
      entry.card.attach(result.claimId, result.remainingMs, () => {
        if (entry.claimId !== result.claimId) return;
        const requestId = crypto.randomUUID(); entry.requestId = requestId; this.requests.set(requestId, entry);
        this.send({ op: 'dsh-question-wait', requestId, sessionId: entry.sessionId, questionId: entry.questionId, action: 'timeout', claimId: result.claimId });
      });
    } else if (result.kind === 'ended' || result.kind === 'submitted') {
      if (entry.claimId !== result.claimId) return;
      this.requests.delete(message.requestId);
      if (message.requestId === entry.requestId) entry.requestId = undefined;
      // A timeout's HTTP ACK does not end the native claim. The Host closes
      // it after accepting the waterfall result, or disconnect releases it.
      if (result.kind === 'ended') {
        entry.claimId = undefined; entry.card.detach(result.claimId);
        if (entry.card.snapshot().phase === 'open') entry.error = '原生等待连接已结束，请重新核对问题。';
      }
    } else {
      this.requests.delete(message.requestId); entry.requestId = undefined; entry.claimId = undefined;
      entry.error = result.error; entry.card.detach();
    }
    this.changed();
  }
}

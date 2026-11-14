import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { EventData, NativeObservation, ReconciliationView, StoredEvent } from '@webdcc/protocol';
import { isValidEventData, resolveAnswer } from '@webdcc/protocol';
import type { Db } from './db.js';
import type { Store } from './store.js';
import { payloadHash } from './command-journal.js';
import { processState } from './process-identity.js';

const conflict = (message: string): Error => Object.assign(new Error(message), { statusCode: 409 });
interface Saved { view: ReconciliationView; fingerprint: string }
interface Row { data: string; applied: number }

/** A read-only native observation is reviewable evidence, not permission to
 * resend missing inputs. Applying it only closes explicitly identified turns. */
export class NativeReconciliationStore {
  constructor(private readonly db: Db, private readonly store: Store) {}
  private safe(observation: NativeObservation): NativeObservation {
    return { ...observation, notes: observation.notes.map(note => String(this.store.nativeEvents.diagnosticValue(note))),
      turns: observation.turns.map(turn => ({ ...turn, items: turn.items.map(item => {
        const data = this.store.nativeEvents.diagnosticValue(item.data);
        return { ...item, native: this.store.nativeEvents.diagnosticValue(item.native),
          ...(isValidEventData(item.kind, data) ? { data: data as typeof item.data } : { kind: 'internal' as const, data: { nativeType: 'sensitive-or-unmapped-native-item' } }) };
      }) })) };
  }
  private fingerprint(sessionId: string): string {
    const session = this.store.getSession(sessionId);
    return payloadHash({ session, owner: this.store.nativeOwners.get(sessionId),
      process: this.store.nativeOwners.managedProcess(sessionId), queue: this.store.journal.queue(sessionId),
      interactions: this.db.prepare('SELECT * FROM interactions WHERE session_id = ? ORDER BY kind, id').all(sessionId) });
  }
  get(sessionId: string, revision?: string): ReconciliationView | null {
    const row = revision === undefined
      ? this.db.prepare('SELECT data, applied FROM native_reconciliations WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(sessionId) as Row | undefined
      : this.db.prepare('SELECT data, applied FROM native_reconciliations WHERE session_id = ? AND revision = ?').get(sessionId, revision) as Row | undefined;
    if (row === undefined) return null;
    const saved = JSON.parse(row.data) as Saved;
    const view = { ...saved.view, applied: row.applied === 1 };
    if (view.applied) view.canApply = false;
    if (!view.applied && (Date.now() - Date.parse(view.observedAt) > 60_000 || saved.fingerprint !== this.fingerprint(sessionId))) {
      view.canApply = false; view.reasons = [...view.reasons, '会话状态或核对时效已变化，请重新读取原生状态。'];
    }
    return view;
  }
  private assess(sessionId: string, observation: NativeObservation): ReconciliationView {
    const session = this.store.getSession(sessionId);
    if (session === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    const owner = this.store.nativeOwners.get(sessionId);
    const reasons: string[] = [];
    const writer = processState(this.store.nativeOwners.managedProcess(sessionId));
    const process = this.store.nativeOwners.managedProcess(sessionId);
    const profile = process?.profilePath;
    if (!process?.nativeVersion || process.nativeVersion !== observation.version) reasons.push('原生版本身份缺失或与观察版本不一致。');
    if (!profile || !observation.profilePath || resolve(profile) !== resolve(observation.profilePath)) reasons.push('原生配置目录身份缺失或已变化。');
    if (owner === undefined || !['uncertain', 'released'].includes(owner.state)) reasons.push('托管实例仍持有会话或缺少可核对的运行身份。');
    if (writer !== 'exited') reasons.push(writer === 'running' ? '原来的托管进程仍在运行。' : '无法证明原来的托管进程已经退出。');
    if (observation.releasePolicy !== 'managed-process') reasons.push('此原生连接需要专用仲裁对账，当前不能释放。');
    if (observation.nativeId !== session.nativeId || observation.agent !== session.agent) reasons.push('原生观察身份与此会话不一致。');
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (observation.cwd === null || workspace === undefined || resolve(observation.cwd) !== resolve(workspace.path)) reasons.push('原生工作区身份未确认或已变化。');
    if (observation.state === 'running' || observation.turns.some(turn => turn.status === 'inProgress')) reasons.push('原生记录仍包含运行中的工作。');
    const events = this.store.allEvents(sessionId);
    const unfinished = new Set(events.filter(event => event.kind === 'turn.started' && !events.some(end => end.kind === 'turn.completed' && end.turnId === event.turnId)).flatMap(event => event.turnId === null ? [] : [event.turnId]));
    for (const row of this.store.journal.queue(sessionId)) if (row.state === 'uncertain') unfinished.add(row.turnId);
    const outcomes: ReconciliationView['outcomes'] = [];
    for (const turnId of unfinished) {
      const matches = observation.turns.filter(turn => this.store.nativeHistory.turn(sessionId, turn.nativeTurnId) === turnId || turn.clientCommandIds.some(id => {
        const native = this.store.journal.nativeInput(sessionId, id);
        if (native !== undefined) return native.turnId === turnId;
        const command = this.store.journal.get(id); return command?.sessionId === sessionId && command.turnId === turnId;
      }));
      if (matches.length !== 1) { reasons.push(`轮次 ${turnId} 没有唯一的原生身份和终态证据。`); continue; }
      const turn = matches[0]!;
      const mapped = this.store.nativeHistory.turn(sessionId, turn.nativeTurnId);
      if (mapped !== undefined && mapped !== turnId || outcomes.some(outcome => outcome.nativeTurnId === turn.nativeTurnId)) { reasons.push('原生与 Web 轮次映射存在冲突。'); continue; }
      if (turn.status === 'inProgress' || !turn.itemsComplete || turn.completedAt === null || !Number.isFinite(Date.parse(turn.completedAt))) { reasons.push(`原生轮次 ${turn.nativeTurnId} 的终态或内容尚未完整读取。`); continue; }
      outcomes.push({ turnId, nativeTurnId: turn.nativeTurnId, status: turn.status });
    }
    // A response outcome is still unknown if its request cannot be associated
    // with one of the terminal turns. Never silently unlock such a response.
    for (const row of this.db.prepare("SELECT kind, id FROM interactions WHERE session_id = ? AND state NOT IN ('resolved','cancelled')").all(sessionId) as { kind: string; id: string }[]) {
      const event = events.findLast(event => row.kind === 'answer' ? event.kind === 'question' && (event.data as EventData['question']).questionId === row.id
        : event.kind === 'approval.request' && (event.data as EventData['approval.request']).approvalId === row.id);
      if (event?.turnId == null || !outcomes.some(outcome => outcome.turnId === event.turnId)) reasons.push(`交互 ${row.id} 缺少已结束原生轮次的关联证据。`);
    }
    return { revision: randomUUID(), sessionId, generation: owner?.generation ?? null, observedAt: new Date().toISOString(), observation,
      writer, canApply: reasons.length === 0, reasons, applied: false, outcomes };
  }
  capture(sessionId: string, observation: NativeObservation): ReconciliationView {
    const safe = this.safe(observation);
    if (Buffer.byteLength(JSON.stringify(safe)) > 2 * 1024 * 1024) throw Object.assign(new Error('核对记录超过2 MiB，请缩小历史窗口'), { statusCode: 413 });
    const view = this.assess(sessionId, safe);
    this.db.prepare('INSERT INTO native_reconciliations (revision, session_id, generation, owner_id, native_id, observed_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(view.revision, sessionId, view.generation, this.store.nativeOwners.get(sessionId)?.ownerId ?? null, observation.nativeId, view.observedAt,
        JSON.stringify({ view, fingerprint: this.fingerprint(sessionId) } satisfies Saved));
    this.db.prepare('DELETE FROM native_reconciliations WHERE session_id = ? AND rowid NOT IN (SELECT rowid FROM native_reconciliations WHERE session_id = ? ORDER BY rowid DESC LIMIT 20)').run(sessionId, sessionId);
    return view;
  }
  apply(sessionId: string, revision: string, fresh: NativeObservation): { view: ReconciliationView; events: StoredEvent[]; feedSeq: number } {
    fresh = this.safe(fresh);
    return this.db.transaction(() => {
      const previous = this.get(sessionId, revision);
      if (previous === null || previous.applied || !previous.canApply) throw conflict('核对记录已过期、已应用或不可恢复，请重新核对');
      const current = this.assess(sessionId, fresh);
      if (!current.canApply || payloadHash(current.outcomes) !== payloadHash(previous.outcomes)) throw conflict('原生状态已变化或仍未确认，请重新核对');
      const targetTurns = (observation: NativeObservation) => current.outcomes.map(outcome => observation.turns.find(turn => turn.nativeTurnId === outcome.nativeTurnId));
      if (payloadHash(targetTurns(fresh)) !== payloadHash(targetTurns(previous.observation))) throw conflict('原生轮次内容已变化，请重新核对');
      const events: StoredEvent[] = [];
      const append = (value: Parameters<Store['appendEvent']>[0]): void => { events.push(this.store.appendEvent(value)); };
      for (const outcome of current.outcomes) {
        this.store.nativeHistory.bind(sessionId, outcome.nativeTurnId, outcome.turnId);
        const turn = fresh.turns.find(turn => turn.nativeTurnId === outcome.nativeTurnId)!;
        const existing = this.store.allEvents(sessionId).filter(event => event.turnId === outcome.turnId);
        const base = { sessionId, turnId: outcome.turnId, at: turn.completedAt!, native: { source: 'native-reconciliation', revision, nativeTurnId: turn.nativeTurnId } };
        for (const item of turn.items) {
          if (item.kind === 'user.message') continue;
          if (existing.some(event => event.itemKey === item.itemKey && payloadHash(event.data) === payloadHash(item.data))) continue;
          append({ ...base, itemKey: item.itemKey, kind: item.kind, data: item.data, native: this.store.nativeEvents.diagnosticValue(item.native) });
        }
        const questions = new Map(existing.filter(event => event.kind === 'question').map(event => [(event.data as EventData['question']).questionId, event]));
        for (const event of questions.values()) {
          const data = event.data as EventData['question'];
          if (data.status === 'answered' || data.status === 'skipped') continue;
          const { submission: _submission, ...question } = data; void _submission;
          append({ ...base, itemKey: event.itemKey, kind: 'question', data: { ...question, status: 'skipped', resolution: 'outcome-unknown' } });
        }
        for (const event of existing.filter(event => event.kind === 'approval.request')) {
          const data = event.data as EventData['approval.request'];
          if (this.store.interactions.get(sessionId, 'approve', data.approvalId)?.state === 'resolved') continue;
          append({ ...base, itemKey: `reconciled-approval-${data.approvalId}`, kind: 'approval.resolved', data: { approvalId: data.approvalId, optionId: 'outcome-unknown', by: 'system' } });
        }
        const projected = this.store.allEvents(sessionId).filter(event => event.turnId === outcome.turnId);
        const startedAt = turn.startedAt ?? projected.find(event => event.kind === 'turn.started')?.at ?? turn.completedAt!;
        append({ ...base, itemKey: `reconciled-turn-${outcome.turnId}`, kind: 'turn.completed', data: { status: outcome.status,
          durationMs: Math.max(0, Date.parse(turn.completedAt!) - Date.parse(startedAt)), answerItemKeys: resolveAnswer(projected).map(event => event.itemKey),
          reason: '原生历史已确认终态；交互答案是否被接收未作推断。' } });
        this.store.journal.inputState(outcome.turnId, outcome.status === 'completed' ? 'completed' : 'failed');
      }
      const owner = this.store.nativeOwners.get(sessionId)!;
      this.store.nativeOwners.reconcileRelease(sessionId, owner.ownerId, owner.generation);
      const { feedSeq } = this.store.updateSessionAndFeed(sessionId, { status: 'idle' }, { status: 'idle', queueRevision: Date.now() });
      this.db.prepare('UPDATE native_reconciliations SET applied = 1 WHERE revision = ?').run(revision);
      return { view: { ...previous, applied: true, canApply: false }, events, feedSeq };
    })();
  }
}

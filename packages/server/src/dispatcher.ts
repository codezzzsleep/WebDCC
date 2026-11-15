import type { Command, UserInput } from '@webdcc/protocol';
import type { FileStore } from './files.js';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';
import type { InteractionRecorder } from './interaction-recorder.js';
import { payloadHash } from './command-journal.js';

export interface DispatchResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
}

const INTERRUPT_TTL_MS = 60_000;

/** 命令处理：去重、执行、记录结果（SPEC 7.4） */
export class CommandDispatcher {
  private readonly inFlight = new Map<string, Promise<DispatchResult>>();
  constructor(
    private readonly store: Store,
    private readonly manager: SessionManager,
    files: FileStore,
    private readonly recorder?: InteractionRecorder,
  ) { this.manager.bindFileStore(files); }

  async dispatch(command: Command): Promise<DispatchResult> {
    const owner = 'sessionId' in command ? command.sessionId : `command-${command.clientCommandId}`;
    const previous = this.store.journal.get(command.clientCommandId);
    if (previous?.payloadHash !== null && previous?.payloadHash !== undefined && previous.payloadHash !== payloadHash(command)) return { ok: false, code: 'command-conflict', error: '相同命令 ID 的正文不一致' };
    let prepared: UserInput | undefined;
    if (command.op === 'send' && previous === undefined) {
      try {
        prepared = await this.manager.prepareInput(command.sessionId, { text: command.text,
          ...(command.images === undefined ? {} : { images: command.images.map(fileId => ({ fileId })) }),
          ...(command.contentParts === undefined ? {} : { contentParts: command.contentParts }),
          ...(command.intent === undefined ? {} : { delivery: command.intent }),
          ...(command.expectedTurnId === undefined ? {} : { expectedTurnId: command.expectedTurnId }) });
      } catch (error) { return this.failure(error, false); }
    }
    const sensitive = this.store.journal.isSensitive(command);
    if (sensitive && command.op === 'answer') {
      try { this.manager.protectAnswer(command.sessionId, command.questionId, command.answer); }
      catch { return { ok: false, code: 'bad-request', error: '问题答案格式无效' }; }
    }
    const diagnostic = sensitive && command.op === 'answer' ? { ...command, answer: { omitted: 'sensitive-answer' } } : command;
    this.recorder?.record(owner, 'web', 'command', diagnostic, 'out');
    const claimed = this.store.journal.claim(command);
    if (claimed.conflict) return { ok: false, code: 'command-conflict', error: '相同命令 ID 的正文不一致' };
    const running = this.inFlight.get(command.clientCommandId);
    if (running !== undefined) return running;
    if (claimed.record.state === 'uncertain' || claimed.record.payloadHash === null) return { ok: false, code: 'uncertain', error: '原生执行结果待核对，禁止自动重发' };
    if (claimed.record.result !== undefined) return claimed.record.result as DispatchResult;
    if (!this.store.journal.acquire(command.clientCommandId)) return { ok: true, value: { commandId: command.clientCommandId, state: claimed.record.state, turnId: claimed.record.turnId, queued: claimed.record.state === 'queued' } };
    const pending = this.execute(command, prepared).then(nativeResult => {
      const result = this.store.nativeEvents.redact(nativeResult) as DispatchResult;
      const state = this.store.journal.get(command.clientCommandId)?.state;
      const blockedInput = command.op === 'send' ? this.store.journal.queue(command.sessionId).find(row => row.commandId === command.clientCommandId && row.preparationError !== undefined) : undefined;
      const interaction = command.op === 'answer' ? this.store.interactions.get(command.sessionId, 'answer', command.questionId)
        : command.op === 'approve' ? this.store.interactions.get(command.sessionId, 'approve', command.approvalId) : undefined;
      const acceptedState = interaction === undefined ? 'completed' : interaction.state === 'collected' ? 'queued'
        : interaction.state === 'resolved' || interaction.state === 'cancelled' ? 'completed' : interaction.state === 'uncertain' ? 'uncertain' : 'dispatching';
      this.store.journal.state(command.clientCommandId, blockedInput !== undefined ? 'queued' : result.ok ? command.op === 'send' && state !== undefined ? state : acceptedState : result.code === 'uncertain' ? 'uncertain' : 'failed', result);
      this.recorder?.record(owner, 'web', 'ack', result, 'in');
      return result;
    });
    this.inFlight.set(command.clientCommandId, pending);
    try { return await pending; } finally { this.inFlight.delete(command.clientCommandId); }
  }

  private async execute(command: Command, prepared?: UserInput): Promise<DispatchResult> {
    try {
      switch (command.op) {
        case 'send': {
          prepared ??= await this.manager.prepareInput(command.sessionId, { text: command.text,
            ...(command.images === undefined ? {} : { images: command.images.map(fileId => ({ fileId })) }),
            ...(command.contentParts === undefined ? {} : { contentParts: command.contentParts }),
            ...(command.intent === undefined ? {} : { delivery: command.intent }),
            ...(command.expectedTurnId === undefined ? {} : { expectedTurnId: command.expectedTurnId }) });
          for (const attachment of prepared.contentParts?.parts ?? prepared.images ?? []) if ('fileId' in attachment) this.recorder?.record(command.sessionId, 'file', 'attachment-resolved', attachment);
          const { turnId, queued, confirmed } = await this.manager.send(
            command.sessionId,
            prepared,
            command.clientCommandId,
          );
          return { ok: true, value: { turnId, queued, ...(confirmed === undefined ? {} : { confirmed }) } };
        }
        case 'approve': {
          if (this.store.hasApprovalResolved(command.sessionId, command.approvalId)) {
            return { ok: false, error: 'already-resolved', code: 'already-resolved' };
          }
          await this.manager.approve(command.sessionId, {
            approvalId: command.approvalId,
            optionId: command.optionId,
          }, command.clientCommandId);
          return { ok: true };
        }
        case 'answer': {
          const value = await this.manager.answer(command.sessionId, command.questionId, command.answer, command.clientCommandId);
          return { ok: true, value };
        }
        case 'interrupt': {
          if (typeof command.createdAt === 'number' && Date.now() - command.createdAt > INTERRUPT_TTL_MS) {
            return { ok: false, error: '打断未送达，Agent 可能仍在运行', code: 'interrupt-expired' };
          }
          await this.manager.interrupt(command.sessionId);
          return { ok: true };
        }
        case 'create-session': {
          if (command.providerId !== null && command.providerId !== undefined && (command.model === undefined || command.model === '')) {
            return { ok: false, error: '选择 Provider 时必须指定模型', code: 'model-required' };
          }
          const session = await this.manager.createSession({
            workspaceId: command.workspaceId,
            agent: command.agent as never,
            providerId: command.providerId ?? null,
            ...(command.model === undefined ? {} : { model: command.model }),
            ...(command.reasoningEffort === undefined ? {} : { reasoningEffort: command.reasoningEffort }),
            ...(command.accessMode === undefined ? {} : { accessMode: command.accessMode }),
            ...(command.parentId === undefined ? {} : { parentId: command.parentId }),
          });
          return { ok: true, value: { sessionId: session.id } };
        }
        case 'set-access-mode': {
          const applied = await this.manager.setAccessMode(command.sessionId, command.accessMode);
          return { ok: true, value: { accessMode: applied } };
        }
        case 'set-model': {
          await this.manager.setModel(command.sessionId, command.model);
          return { ok: true, value: { model: command.model } };
        }
        case 'set-reasoning-effort': {
          await this.manager.setReasoningEffort(command.sessionId, command.reasoningEffort);
          return { ok: true, value: { reasoningEffort: command.reasoningEffort } };
        }
        case 'pin': {
          this.manager.updateSessionAndFeed(command.sessionId, { pinned: command.pinned }, { pinned: command.pinned });
          return { ok: true };
        }
        case 'rename': {
          await this.manager.rename(command.sessionId, command.title);
          return { ok: true };
        }
        case 'archive': {
          await this.manager.archive(command.sessionId, command.archived);
          return { ok: true };
        }
        default: {
          const exhaustive: never = command;
          return { ok: false, error: `未知命令：${JSON.stringify(exhaustive)}`, code: 'unknown-command' };
        }
      }
    } catch (error) {
      const native = ['send', 'approve', 'answer', 'interrupt', 'create-session', 'set-model', 'set-access-mode', 'set-reasoning-effort'].includes(command.op);
      return this.failure(error, native);
    }
  }

  private failure(error: unknown, native: boolean): DispatchResult {
    const statusCode = (error as { statusCode?: number }).statusCode; const code = (error as { code?: string }).code;
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: code === 'native-version-incompatible' || code === 'uncertain' ? code
      : statusCode === 404 ? 'not-found' : statusCode === 409 ? 'conflict' : statusCode === 403 ? 'forbidden' : statusCode === 413 ? 'too-large' : statusCode === 400 ? 'bad-request' : native ? 'uncertain' : 'failed' };
  }
}

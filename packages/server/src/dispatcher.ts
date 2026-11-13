import type { Command } from '@webdcc/protocol';
import type { FileStore } from './files.js';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';
import type { InteractionRecorder } from './interaction-recorder.js';

export interface DispatchResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
}

const INTERRUPT_TTL_MS = 60_000;

/** 命令处理：去重、执行、记录结果（SPEC 7.4） */
export class CommandDispatcher {
  constructor(
    private readonly store: Store,
    private readonly manager: SessionManager,
    private readonly files: FileStore,
    private readonly recorder?: InteractionRecorder,
  ) {}

  async dispatch(command: Command): Promise<DispatchResult> {
    const owner = 'sessionId' in command ? command.sessionId : `command-${command.clientCommandId}`;
    this.recorder?.record(owner, 'web', 'command', command, 'out');
    const existing = this.store.getCommandResult(command.clientCommandId);
    if (existing !== undefined) return existing.result as DispatchResult;

    const result = await this.execute(command);
    this.store.recordCommand(command.clientCommandId, command.op, result);
    this.recorder?.record(owner, 'web', 'ack', result, 'in');
    return result;
  }

  private async execute(command: Command): Promise<DispatchResult> {
    try {
      switch (command.op) {
        case 'send': {
          const images = (command.images ?? []).map((fileId) => {
            const file = this.store.getFile(fileId);
            const path = this.files.resolvePath(fileId);
            if (file === undefined || path === undefined) throw Object.assign(new Error('上传文件不存在，消息未发送'), { statusCode: 404 });
            this.recorder?.record(command.sessionId, 'file', 'attachment-resolved', { fileId, path, mime: file.mime, sha256: file.sha256, bytes: file.size });
            return { fileId, path, mime: file.mime };
          });
          const { turnId, queued } = await this.manager.send(
            command.sessionId,
            { text: command.text, ...(images.length === 0 ? {} : { images }) },
            command.clientCommandId,
          );
          return { ok: true, value: { turnId, queued } };
        }
        case 'approve': {
          if (this.store.hasApprovalResolved(command.sessionId, command.approvalId)) {
            return { ok: false, error: 'already-resolved', code: 'already-resolved' };
          }
          await this.manager.approve(command.sessionId, {
            approvalId: command.approvalId,
            optionId: command.optionId,
          });
          return { ok: true };
        }
        case 'answer': {
          await this.manager.answer(command.sessionId, command.questionId, command.answer);
          return { ok: true };
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
      const statusCode = (error as { statusCode?: number }).statusCode;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(statusCode === 404 ? { code: 'not-found' } : {}),
      };
    }
  }
}

import type { Command } from '@webdcc/protocol';
import type { FileStore } from './files.js';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';

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
  ) {}

  async dispatch(command: Command): Promise<DispatchResult> {
    const existing = this.store.getCommandResult(command.clientCommandId);
    if (existing !== undefined) return existing.result as DispatchResult;

    const result = await this.execute(command);
    this.store.recordCommand(command.clientCommandId, command.op, result);
    return result;
  }

  private async execute(command: Command): Promise<DispatchResult> {
    try {
      switch (command.op) {
        case 'send': {
          const images = (command.images ?? []).flatMap((fileId) => {
            const file = this.store.getFile(fileId);
            const path = this.files.resolvePath(fileId);
            if (file === undefined || path === undefined) return [];
            return [{ fileId, path, mime: file.mime }];
          });
          const { turnId } = await this.manager.send(
            command.sessionId,
            { text: command.text, ...(images.length === 0 ? {} : { images }) },
            command.clientCommandId,
          );
          return { ok: true, value: { turnId } };
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
          const session = await this.manager.createSession({
            workspaceId: command.workspaceId,
            agent: command.agent as never,
            providerId: command.providerId ?? null,
            ...(command.model === undefined ? {} : { model: command.model }),
            ...(command.accessMode === undefined ? {} : { accessMode: command.accessMode }),
          });
          return { ok: true, value: { sessionId: session.id } };
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

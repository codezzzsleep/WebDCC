/** 同步协议类型（SPEC 7.2、7.4） */
import type { EventData, EventKind, StoredEvent } from './events.js';
import type { SessionDto } from './api.js';
import type { PermissionState } from './permissions.js';
import type { InputContent, InputIntent } from './input.js';

export interface SubscribeItem {
  sessionId: string;
  afterSeq: number;
}

export interface HelloMessage {
  op: 'hello';
  clientId: string;
  feedAfter: number;
  subscribe: SubscribeItem[];
}

export interface SubscribeMessage {
  op: 'subscribe';
  subscribe: SubscribeItem[];
}

export interface UnsubscribeMessage {
  op: 'unsubscribe';
  sessionIds: string[];
}

export interface PongMessage {
  op: 'pong';
}

export type CommandOp = 'send' | 'approve' | 'answer' | 'interrupt' | 'create-session' | 'rename' | 'archive' | 'set-access-mode' | 'set-model' | 'set-reasoning-effort' | 'pin';

export interface CommandBase {
  op: CommandOp;
  clientCommandId: string;
}

export interface SendCommand extends CommandBase {
  op: 'send';
  sessionId: string;
  text: string;
  images?: string[];
  contentParts?: InputContent;
  intent?: InputIntent;
  expectedTurnId?: string;
  /** 输入框原文与发送文本逐字节相等（SPEC 3.3） */
}

export interface ApproveCommand extends CommandBase {
  op: 'approve';
  sessionId: string;
  approvalId: string;
  optionId: string;
}

export interface AnswerCommand extends CommandBase {
  op: 'answer';
  sessionId: string;
  questionId: string;
  answer: unknown;
}

export interface InterruptCommand extends CommandBase {
  op: 'interrupt';
  sessionId: string;
  /** 命令创建时间，用于 60 秒过期判断 */
  createdAt: number;
}

export interface CreateSessionCommand extends CommandBase {
  op: 'create-session';
  workspaceId: string;
  agent: string;
  providerId?: string | null;
  model?: string;
  reasoningEffort?: string;
  accessMode?: string;
  /** 接续会话：从哪个会话"在另一个 Agent 中继续"而来（只用于展示接力关系，不传任何内容给 Agent） */
  parentId?: string;
  draftText?: string;
}

export interface RenameCommand extends CommandBase {
  op: 'rename';
  sessionId: string;
  title: string;
}

export interface ArchiveCommand extends CommandBase {
  op: 'archive';
  sessionId: string;
  archived: boolean;
}

export interface PinCommand extends CommandBase {
  op: 'pin';
  sessionId: string;
  pinned: boolean;
}

export interface SetAccessModeCommand extends CommandBase {
  op: 'set-access-mode';
  sessionId: string;
  accessMode: string;
}

export interface SetModelCommand extends CommandBase {
  op: 'set-model';
  sessionId: string;
  model: string;
}

export interface SetReasoningEffortCommand extends CommandBase {
  op: 'set-reasoning-effort';
  sessionId: string;
  reasoningEffort: string;
}

export type Command =
  | PinCommand
  | SetAccessModeCommand
  | SetModelCommand
  | SetReasoningEffortCommand
  | SendCommand
  | ApproveCommand
  | AnswerCommand
  | InterruptCommand
  | CreateSessionCommand
  | RenameCommand
  | ArchiveCommand;

export interface CommandMessage {
  op: 'command';
  command: Command;
}

export type ClientMessage = HelloMessage | SubscribeMessage | UnsubscribeMessage | CommandMessage | PongMessage;

export interface FeedPatch {
  permissions?: PermissionState;
  queueRevision?: number;
  title?: string;
  /** 创建事件里带上会话身份，便于新浏览器只靠 feed 重建侧边栏 */
  agent?: string;
  createdAt?: string;
  status?: 'idle' | 'running' | 'waiting' | 'error';
  updatedAt?: string;
  pinned?: boolean;
  archived?: boolean;
  workspaceId?: string;
  created?: boolean;
  draftSeq?: number;
  /** 访问模式 / 模型 / Provider 变化（F6、AG-*-12） */
  accessMode?: string;
  model?: string;
  reasoningEffort?: string;
  providerId?: string | null;
  /** 接续会话的上一棒 */
  parentId?: string;
  handoffKind?: SessionDto['handoffKind'];
}

export interface FeedMessage {
  op: 'feed';
  feedSeq: number;
  sessionId: string;
  patch: FeedPatch;
}

export interface EventMessage {
  op: 'event';
  event: StoredEvent;
  /** Initial history is rendered but must not become a new unread notification. */
  history?: boolean;
}

export interface SnapshotItem {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId?: string | null;
}

export interface SnapshotMessage {
  op: 'snapshot';
  sessionId: string;
  items: SnapshotItem[];
}

export interface DeltaMessage {
  op: 'delta';
  sessionId: string;
  itemKey: string;
  field: 'text' | 'output';
  append: string;
  /** Public turn identity; omitted only by legacy senders. */
  turnId?: string | null;
}

export interface UpdateMessage {
  op: 'update';
  sessionId: string;
  itemKey: string;
  data: unknown;
  /** 该条目所属的轮次（F4：流式帧必须带 turnId） */
  turnId?: string | null;
}

export interface AckMessage {
  op: 'ack';
  clientCommandId: string;
  result: { ok: true; value?: unknown } | { ok: false; error: string; code?: string };
  seq?: number;
}

export interface PingMessage {
  op: 'ping';
}

export type ServerMessage = FeedMessage | EventMessage | SnapshotMessage | DeltaMessage | UpdateMessage | AckMessage | PingMessage;

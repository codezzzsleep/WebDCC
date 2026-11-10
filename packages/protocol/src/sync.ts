/** 同步协议类型（SPEC 7.2、7.4） */
import type { EventData, EventKind, StoredEvent } from './events.js';

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

export type CommandOp = 'send' | 'approve' | 'answer' | 'interrupt' | 'create-session' | 'rename' | 'archive';

export interface CommandBase {
  op: CommandOp;
  clientCommandId: string;
}

export interface SendCommand extends CommandBase {
  op: 'send';
  sessionId: string;
  text: string;
  images?: string[];
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
  accessMode?: string;
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

export type Command =
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
  title?: string;
  status?: 'idle' | 'running' | 'waiting' | 'error';
  updatedAt?: string;
  pinned?: boolean;
  archived?: boolean;
  workspaceId?: string;
  created?: boolean;
  draftSeq?: number;
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
}

export interface SnapshotItem {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId?: string;
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
}

export interface UpdateMessage {
  op: 'update';
  sessionId: string;
  itemKey: string;
  data: unknown;
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

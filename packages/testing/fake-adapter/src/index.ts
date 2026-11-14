import type {
  AdapterEvent,
  AgentAdapter,
  AgentId,
  ApprovalDecision,
  CreateOpts,
  LaunchSpec,
  ModelOption,
  ProbeResult,
  UserInput,
} from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
export * from './replay.js';

export interface FakeAdapterOptions {
  id?: AgentId;
  /** 每个事件之间的延迟（毫秒） */
  delayMs?: number;
  /** 一轮里额外插入多少个 tool.call 条目（A10 的 10,000 帧用） */
  itemsPerTurn?: number;
  /** 注入一个未知类型事件（A11） */
  injectUnknown?: boolean;
  /** 注入一个内部事件 */
  injectInternal?: boolean;
  /** 注入一次审批请求 */
  injectApproval?: boolean;
  /** 注入一次提问 */
  injectQuestion?: boolean;
  /** 让增量乱序到达（A10 的乱序用例） */
  disorder?: boolean;
}

interface SessionState {
  nativeId: string;
  cancelled: boolean;
  timers: Set<NodeJS.Timeout>;
  approval: { id: string; resolve: (decision: ApprovalDecision) => void } | null;
  question: { id: string; resolve: (answer: unknown) => void } | null;
}

const ACCESS_MODES: Record<AgentId, { id: string; label: string }[]> = {
  dsh: [
    { id: 'read-only', label: '仅可查看' },
    { id: 'workspace-write', label: '工作区内修改' },
    { id: 'danger-full-access', label: '完全权限' },
    { id: 'auto', label: '自动审查' },
  ],
  codex: [
    { id: 'read-only', label: '只读' },
    { id: 'workspace', label: '工作区可写' },
    { id: 'workspace-auto', label: '工作区可写 + 自动审批' },
    { id: 'danger-full-access', label: '完全访问' },
  ],
  'claude-code': [
    { id: 'default', label: '默认（每次询问）' },
    { id: 'acceptEdits', label: '自动接受编辑' },
    { id: 'plan', label: '计划模式' },
    { id: 'dontAsk', label: '不询问' },
    { id: 'auto', label: '自动' },
    { id: 'bypassPermissions', label: '跳过权限' },
  ],
};

/** 按脚本回放的假 adapter：给 M1/M2 的前后端联调用，不依赖任何真实 Agent */
export class FakeAdapter implements AgentAdapter {
  readonly id: AgentId;
  readonly kind = 'fake' as const;
  private readonly options: FakeAdapterOptions;
  private readonly listeners: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
    this.id = options.id ?? 'dsh';
  }

  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void {
    this.listeners.push(cb);
  }

  private emit(sessionId: string, event: AdapterEvent): void {
    for (const listener of this.listeners) listener(sessionId, event);
  }

  async probe(): Promise<ProbeResult> {
    return { installed: true, version: 'fake-1.0.0', pinnedVersion: 'fake-1.0.0', auth: 'ok', notes: ['假 adapter（M1/M2 联调用）'] };
  }

  async listModels(): Promise<ModelOption[]> {
    return [{ id: 'fake-model', label: 'Fake Model' }];
  }

  accessModes(): { id: string; label: string }[] {
    return ACCESS_MODES[this.id];
  }

  buildLaunchSpec(opts: CreateOpts): LaunchSpec {
    return { command: 'fake-agent', args: ['--cwd', opts.cwd], env: {}, startParams: { model: opts.model ?? null } };
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    const nativeId = `fake-${ulid()}`;
    this.sessions.set(opts.sessionId, {
      nativeId,
      cancelled: false,
      timers: new Set(),
      approval: null,
      question: null,
    });
    this.emit(opts.sessionId, { type: 'permissions', observation: { effective: opts.accessMode ?? this.accessModes()[0]?.id ?? 'default', source: 'fake/create', scope: 'session' } });
    return { nativeId };
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    this.sessions.set(opts.sessionId, {
      nativeId: opts.nativeId,
      cancelled: false,
      timers: new Set(),
      approval: null,
      question: null,
    });
    this.emit(opts.sessionId, { type: 'permissions', observation: { effective: opts.accessMode ?? this.accessModes()[0]?.id ?? 'default', source: 'fake/resume', scope: 'session' } });
  }

  async setAccessMode(sessionId: string, mode: string): Promise<{ accessMode: string }> {
    this.emit(sessionId, { type: 'permissions', observation: { effective: mode === 'inherit' ? this.accessModes()[0]?.id ?? 'default' : mode, source: 'fake/setAccessMode', scope: 'session' } });
    return { accessMode: mode };
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) throw new Error('fake-adapter: 会话未创建');
    state.cancelled = false;
    const turnId = ulid();
    void this.runTurn(sessionId, turnId, input, state);
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.cancelled = true;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    state.approval?.resolve({ approvalId: state.approval.id, optionId: 'cancelled' });
    state.approval = null;
    const turnId = ulid();
    this.emit(sessionId, {
      type: 'item.complete',
      itemKey: `turn-${turnId}`,
      kind: 'turn.completed',
      data: { status: 'interrupted', durationMs: 1000 },
    });
    this.emit(sessionId, { type: 'status', status: 'idle' });
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.approval === null) return;
    const pending = state.approval;
    state.approval = null;
    pending.resolve(decision);
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.question === null) return;
    if (state.question.id !== questionId) return;
    const pending = state.question;
    state.question = null;
    pending.resolve(answer);
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.cancelled = true;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    this.sessions.delete(sessionId);
  }

  private sleep(state: SessionState, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.timers.delete(timer);
        resolve();
      }, ms);
      state.timers.add(timer);
    });
  }

  private async runTurn(sessionId: string, turnId: string, input: UserInput, state: SessionState): Promise<void> {
    const delay = this.options.delayMs ?? 5;
    const emit = (event: AdapterEvent): void => this.emit(sessionId, event);
    const chunk = (text: string, size = 8): string[] => {
      const out: string[] = [];
      for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
      return out;
    };

    this.emit(sessionId, { type: 'status', status: 'running' });
    const startedAt = Date.now();
    emit({ type: 'item.complete', itemKey: `turn-start-${turnId}`, kind: 'turn.started', data: {}, turnId });

    // 助手回复（逐字流式）
    const reply = `收到：${input.text.slice(0, 60)}。这是假 adapter 的回放内容。`;
    const messageKey = `msg-${turnId}`;
    emit({ type: 'item.start', itemKey: messageKey, kind: 'assistant.message', data: { text: '' }, turnId });
    for (const piece of chunk(reply)) {
      await this.sleep(state, delay);
      if (state.cancelled) return;
      emit({ type: 'item.delta', itemKey: messageKey, field: 'text', append: piece });
    }
    emit({
      type: 'item.complete',
      itemKey: messageKey,
      kind: 'assistant.message',
      data: { text: reply, phase: 'final' },
      turnId,
    });

    // 命令
    const commandKey = `cmd-${turnId}`;
    emit({
      type: 'item.start',
      itemKey: commandKey,
      kind: 'command',
      data: { command: 'ls -la', label: '列出工作区', status: 'running' },
      turnId,
    });
    for (const piece of chunk('total 12\ndrwxr-xr-x 1 user user 4096 SPEC.md\n')) {
      await this.sleep(state, delay);
      if (state.cancelled) return;
      emit({ type: 'item.delta', itemKey: commandKey, field: 'output', append: piece });
    }
    emit({
      type: 'item.complete',
      itemKey: commandKey,
      kind: 'command',
      data: { command: 'ls -la', label: '列出工作区', status: 'completed', exitCode: 0, outputTail: 'total 12\ndrwxr-xr-x 1 user user 4096 SPEC.md\n' },
      turnId,
    });

    // 改动
    emit({
      type: 'item.complete',
      itemKey: `change-${turnId}`,
      kind: 'file.change',
      data: { changes: [{ path: 'README.md', kind: 'modify', added: 3, removed: 1 }], status: 'completed' },
      turnId,
    });

    // 任务面板
    emit({
      type: 'item.complete',
      itemKey: `plan-${turnId}`,
      kind: 'plan',
      data: { items: [{ text: '读取 SPEC', status: 'completed' }, { text: '写代码', status: 'in_progress' }] },
      turnId,
    });

    if (this.options.injectUnknown === true) {
      emit({
        type: 'item.complete',
        itemKey: `unknown-${turnId}`,
        kind: 'unknown',
        data: { nativeType: 'fake/unknown-event' },
        native: { type: 'fake/unknown-event', payload: { a: 1 } },
        turnId,
      });
    }

    if (this.options.injectInternal === true) {
      emit({
        type: 'item.complete',
        itemKey: `internal-${turnId}`,
        kind: 'internal',
        data: { nativeType: 'fake/internal-event' },
        turnId,
      });
    }

    if (this.options.injectApproval === true) {
      const approvalId = ulid();
      emit({
        type: 'item.complete',
        itemKey: `approval-${approvalId}`,
        kind: 'approval.request',
        data: { approvalId, title: 'Fake Agent 请求运行命令', detail: 'rm -rf build', options: [{ id: 'allow', label: '允许一次' }, { id: 'deny', label: '拒绝' }] },
        turnId,
      });
      emit({ type: 'status', status: 'waiting' });
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        state.approval = { id: approvalId, resolve };
      });
      emit({ type: 'status', status: 'running' });
      if (state.cancelled || decision.optionId === 'cancelled') return;
    }

    if (this.options.injectQuestion === true) {
      const questionId = ulid();
      emit({
        type: 'item.complete',
        itemKey: `question-${questionId}`,
        kind: 'question',
        data: { questionId, prompt: '要继续吗？', header: '确认', options: [{ id: 'yes', label: '继续' }, { id: 'no', label: '停止' }] },
        turnId,
      });
      emit({ type: 'status', status: 'waiting' });
      await new Promise<unknown>((resolve) => {
        state.question = { id: questionId, resolve };
      });
      emit({ type: 'status', status: 'running' });
    }

    // 大批量条目（A10 的 10,000 帧）
    const bulk = this.options.itemsPerTurn ?? 0;
    for (let index = 0; index < bulk; index += 1) {
      if (state.cancelled) return;
      emit({
        type: 'item.complete',
        itemKey: `bulk-${turnId}-${index}`,
        kind: 'tool.call',
        data: { name: 'fake_tool', input: { index }, status: 'completed' },
        turnId,
      });
      if (index % 100 === 0) await this.sleep(state, 0);
    }

    if (state.cancelled) return;
    emit({
      type: 'item.complete',
      itemKey: `turn-end-${turnId}`,
      kind: 'turn.completed',
      data: { status: 'completed', durationMs: Date.now() - startedAt },
      turnId,
    });
    emit({ type: 'status', status: 'idle' });
  }
}

export function createFakeAdapters(options: Omit<FakeAdapterOptions, 'id'> = {}): AgentAdapter[] {
  return [
    new FakeAdapter({ ...options, id: 'dsh' }),
    new FakeAdapter({ ...options, id: 'codex' }),
    new FakeAdapter({ ...options, id: 'claude-code' }),
  ];
}

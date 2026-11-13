import type { AdapterEvent, AgentAdapter, AgentId, ApprovalDecision, CreateOpts, LaunchSpec, ModelOption, ProbeResult, TraceFrame, UserInput } from '@webdcc/protocol';

export interface ReplayAdapterOptions {
  id: AgentId;
  frames: TraceFrame[];
  translate: (frame: TraceFrame) => AdapterEvent[];
  /** Multiple recorded conversations may share one adapter. A replay is
   * selected by the first user input and then resumed on subsequent sends. */
  replays?: ReplayScript[];
  speed?: number;
}

interface ReplayHandler {
  feed: (frame: TraceFrame) => AdapterEvent[];
  respond?: (decision: ApprovalDecision) => Promise<void>;
  answer?: (questionId: string, answer: unknown) => Promise<void>;
}
export interface ReplayScript {
  createHandler?: (sessionId: string) => ReplayHandler;
  key: string;
  prompt?: string;
  frames: TraceFrame[];
  translate: (frame: TraceFrame) => AdapterEvent[];
}

interface ReplaySession { cancelled: boolean; nativeId: string; script?: ReplayScript; handler?: ReplayHandler; cursor: number; lastT: number; }

/** Adapter used by L2/L3: native frames are processed by the production
 * Handler, then delivered at recorded relative times. */
export class ReplayAdapter implements AgentAdapter {
  readonly kind = 'fake' as const;
  readonly id: AgentId;
  private readonly listeners: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private readonly sessions = new Map<string, ReplaySession>();
  private readonly options: ReplayAdapterOptions;

  constructor(options: ReplayAdapterOptions) { this.options = options; this.id = options.id; }
  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void { this.listeners.push(cb); }
  private emit(sessionId: string, event: AdapterEvent): void { for (const listener of this.listeners) listener(sessionId, event); }
  async probe(): Promise<ProbeResult> { return { installed: true, version: 'trace-replay', pinnedVersion: 'trace-replay', auth: 'ok' }; }
  async listModels(): Promise<ModelOption[]> { return [{ id: 'trace-replay', label: 'Trace replay' }]; }
  accessModes(): { id: string; label: string }[] { return [{ id: 'replay', label: '录像回放' }]; }
  buildLaunchSpec(_opts: CreateOpts): LaunchSpec { return { command: 'trace-replay', env: {} }; }
  async create(opts: CreateOpts): Promise<{ nativeId: string }> { const nativeId = `trace:${opts.sessionId}`; this.sessions.set(opts.sessionId, { cancelled: false, nativeId, cursor: 0, lastT: 0 }); return { nativeId }; }
  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> { this.sessions.set(opts.sessionId, { cancelled: false, nativeId: opts.nativeId, cursor: 0, lastT: 0 }); }
  async send(sessionId: string, input: UserInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error('trace replay session not created');
    session.cancelled = false;
    if (session.script === undefined) {
      const scripts = this.options.replays ?? [];
      if (scripts.length > 0) {
        session.script = scripts.find((script) => script.prompt === input.text);
        if (session.script === undefined) throw new Error(`no replay recorded for input: ${input.text}`);
      } else {
        session.script = { key: 'default', frames: this.options.frames, translate: this.options.translate };
      }
    }
    const script = session.script;
    if (script === undefined) throw new Error(`no replay recorded for input: ${input.text}`);
    session.handler ??= script.createHandler?.(sessionId);
    const speed = this.options.speed ?? 1;
    let previous = session.lastT;
    for (; session.cursor < script.frames.length; session.cursor += 1) {
      const frame = script.frames[session.cursor];
      if (frame === undefined) break;
      const delay = Math.max(0, Math.round((frame.t - previous) / speed));
      previous = frame.t;
      session.lastT = frame.t;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (session.cancelled) return;
      const events = session.handler?.feed(frame) ?? script.translate(frame);
      for (const event of events) {
        this.emit(sessionId, event);
        // A single recorded trace can contain more than one user turn (S10).
        // Leave the following native frames for the next send so the server's
        // ULID turn remains the only public identity.
        if (event.type === 'turn.end') {
          session.cursor += 1;
          return;
        }
      }
    }
  }
  async interrupt(sessionId: string): Promise<void> { const session = this.sessions.get(sessionId); if (session !== undefined) session.cancelled = true; }
  async respond(sessionId: string, decision: ApprovalDecision): Promise<void> { await this.sessions.get(sessionId)?.handler?.respond?.(decision); }
  async answer(sessionId: string, questionId: string, answer: unknown): Promise<void> { await this.sessions.get(sessionId)?.handler?.answer?.(questionId, answer); }
  async dispose(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
}

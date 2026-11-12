import type { AdapterEvent, AgentAdapter, AgentId, ApprovalDecision, CreateOpts, LaunchSpec, ModelOption, ProbeResult, TraceFrame, UserInput } from '@webdcc/protocol';

export interface ReplayAdapterOptions {
  id: AgentId;
  frames: TraceFrame[];
  translate: (frame: TraceFrame) => AdapterEvent[];
  speed?: number;
}

interface ReplaySession { cancelled: boolean; nativeId: string; }

/** Adapter used by L2/L3: native frames are translated by the real pure
 * translator, then delivered at recorded relative times. */
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
  async create(opts: CreateOpts): Promise<{ nativeId: string }> { const nativeId = `trace:${opts.sessionId}`; this.sessions.set(opts.sessionId, { cancelled: false, nativeId }); return { nativeId }; }
  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> { this.sessions.set(opts.sessionId, { cancelled: false, nativeId: opts.nativeId }); }
  async send(sessionId: string, _input: UserInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error('trace replay session not created');
    session.cancelled = false;
    const speed = this.options.speed ?? 1;
    let previous = 0;
    for (const frame of this.options.frames) {
      const delay = Math.max(0, Math.round((frame.t - previous) / speed));
      previous = frame.t;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (session.cancelled) return;
      for (const event of this.options.translate(frame)) this.emit(sessionId, event);
    }
  }
  async interrupt(sessionId: string): Promise<void> { const session = this.sessions.get(sessionId); if (session !== undefined) session.cancelled = true; }
  async respond(_sessionId: string, _decision: ApprovalDecision): Promise<void> { return; }
  async dispose(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
}

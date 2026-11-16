/** Mirrors official PendingQuestion focus/edit/hold/hidden-card semantics. */
export interface DshQuestionWaitSnapshot {
  phase: 'open' | 'continued';
  waitState: 'counting' | 'focused' | 'editing' | 'waiting' | 'continued';
  countdown?: { remainingMs: number; running: boolean };
  channel: 'waterfall' | 'rpc' | 'none';
}

export class DshQuestionWaitCard {
  private phase: 'open' | 'continued' = 'open';
  private focused = false;
  private engaged = false;
  private held = false;
  private deadline?: number;
  private remaining?: number;
  private timed = false;
  private claim?: string;
  private timer?: ReturnType<typeof setInterval>;
  private timeout?: () => void;
  private closed = false;
  constructor(private readonly changed: () => void) {}

  snapshot(): DshQuestionWaitSnapshot {
    return { phase: this.phase, waitState: this.phase === 'continued' ? 'continued' : this.held ? 'waiting' : this.engaged ? 'editing' : this.focused ? 'focused' : 'counting',
      ...(this.timed ? { countdown: { remainingMs: this.deadline === undefined ? this.remaining ?? 0 : Math.max(0, this.deadline - Date.now()), running: this.deadline !== undefined } } : {}),
      channel: this.phase === 'continued' ? 'rpc' : this.claim === undefined ? 'none' : 'waterfall' };
  }

  private publish(): void {
    const wanted = this.deadline !== undefined && !this.closed;
    if (wanted && this.timer === undefined) this.timer = setInterval(() => {
      if (this.deadline !== undefined && Date.now() >= this.deadline) this.expire();
      else this.changed();
    }, 1000);
    if (!wanted && this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
    this.changed();
  }

  attach(claim: string, remainingMs: number, timeout: () => void): void {
    if (this.closed || this.phase === 'continued') return;
    this.claim = claim; this.timed = true; this.timeout = timeout;
    if (!this.held && !this.engaged) {
      this.deadline = Date.now() + remainingMs;
      if (this.focused) { this.remaining = remainingMs; this.deadline = undefined; }
    }
    this.publish();
  }
  detach(claim?: string): void {
    if (claim !== undefined && claim !== this.claim) return;
    this.claim = undefined; this.timed = false; this.deadline = undefined; this.timeout = undefined; this.publish();
  }
  continue(): void { this.phase = 'continued'; this.detach(); }
  holdFocus(): void {
    if (this.held || this.engaged || this.focused) return;
    this.remaining = this.deadline === undefined ? undefined : Math.max(0, this.deadline - Date.now());
    this.focused = true; this.deadline = undefined; this.publish();
  }
  releaseFocus(): void {
    if (!this.focused) return;
    this.focused = false; this.deadline = this.timed && this.remaining !== undefined ? Date.now() + this.remaining : undefined;
    this.remaining = undefined; this.publish();
  }
  engage(): void {
    if (this.held || this.engaged) return;
    if (this.remaining === undefined && this.deadline !== undefined) this.remaining = Math.max(0, this.deadline - Date.now());
    this.engaged = true; this.focused = false; this.deadline = undefined; this.publish();
  }
  takeTime(): void {
    if (this.held) return;
    this.held = true; this.focused = false; this.remaining = undefined; this.deadline = undefined; this.publish();
  }
  private expire(): void {
    if (this.held || this.engaged || this.focused || this.claim === undefined) return;
    const timeout = this.timeout; this.detach(); timeout?.();
  }
  close(): void { this.closed = true; this.detach(); }
}

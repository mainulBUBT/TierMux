import type { TimingPhase } from './types';

export class TimerStack {
  private stack: Array<{ phase: TimingPhase; startMs: number }> = [];

  start(phase: TimingPhase): void {
    const top = this.stack[this.stack.length - 1];
    if (top && top.phase === phase) {
      console.warn(`[tiermux-profiler] timerStart('${phase}'): same phase is already on top of the stack — ignored`);
      return;
    }
    this.stack.push({ phase, startMs: Date.now() });
  }

  end(phase: TimingPhase): number | undefined {
    if (this.stack.length === 0) {
      console.warn(`[tiermux-profiler] timerEnd('${phase}'): stack is empty — ignored`);
      return undefined;
    }
    const top = this.stack[this.stack.length - 1];
    if (top.phase !== phase) {
      console.warn(`[tiermux-profiler] timerEnd('${phase}'): expected top phase '${top.phase}', ignoring mismatched end`);
      return undefined;
    }
    this.stack.pop();
    return Date.now() - top.startMs;
  }

  clear(): void {
    this.stack.length = 0;
  }
}

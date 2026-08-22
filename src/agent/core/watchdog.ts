
// Engine-side watchdog: the UI plumbing for watchdog cards has existed since the SDK port
// (chatViewProvider forwards onWatchdogWarning/Actionable/Dismissed; the webview renders
// continueWaiting / restartRequest / switchModel actions), but nothing in the engine ever
// FIRED it — the callbacks were declared optional and never called, so a run hanging on a
// silent model call or a wedged tool showed no watchdog at all. This tracker fixes that:
// it stamps every protocol event (chunks, tool events, reasoning, step labels) as activity,
// and when a turn goes quiet past two thresholds it emits warning → actionable once each.
//
// Deliberately one-way observability (the same contract the webview already assumes): the
// user's button click is handled host-side via abort + pendingWatchdogRetry, not here.
// Safety against post-turn emissions: the host's callbacks are gated on isActiveRun, and the
// tracker self-disarms after the actionable fire — a stop() call at the turn's natural end is
// still made, but early-return paths can never leak a live interval that posts anything.

export interface WatchdogActivityInfo {
  label: string;
  atMs: number;
}

export interface TurnWatchdogHooks {
  onWarning?: (info: { elapsedMs: number; lastActivity?: WatchdogActivityInfo }) => void;
  onActionable?: (info: { elapsedMs: number; lastActivity?: WatchdogActivityInfo; hasPartialOutput: boolean }) => void;
  onDismissed?: () => void;
}

const DEFAULT_WARNING_MS = 45_000;
const DEFAULT_ACTIONABLE_MS = 90_000;
const TICK_MS = 5_000;

export class TurnWatchdog {
  private last: WatchdogActivityInfo = { label: 'turn started', atMs: Date.now() };
  private warned = false;
  private actionableFired = false;
  private partialOutput = false;
  private toolExecuting = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly hooks: TurnWatchdogHooks,
    private readonly isAborted: () => boolean,
    private readonly warningMs = DEFAULT_WARNING_MS,
    private readonly actionableMs = DEFAULT_ACTIONABLE_MS,
  ) {}

  /** Arm the tracker. No-op (and never armed) when the caller wired no hooks — a headless
   *  harness or a test gets zero background timers from this. */
  start(): void {
    if (!this.hooks.onWarning && !this.hooks.onActionable) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Disarm at the turn's natural end; fires onDismissed if any watchdog UI was shown. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.warned) this.hooks.onDismissed?.();
    this.warned = false;
  }

  /** Record a protocol event as activity; dismisses any showing watchdog UI. */
  activity(label: string): void {
    const wasShowing = this.warned;
    this.last = { label, atMs: Date.now() };
    this.warned = false;
    if (wasShowing) this.hooks.onDismissed?.();
  }

  /** Text streamed this turn — feeds hasPartialOutput on the actionable card. */
  markPartialOutput(): void {
    this.partialOutput = true;
  }

  /** A tool is executing (true on 'running', false on 'done'/'error'). An executing tool is
   *  KNOWN work — a build/test/grep can legitimately run minutes between its start and end
   *  events — so the informational warning is suppressed while one runs. The actionable
   *  threshold still fires (a tool wedged past actionableMs is exactly what the action card
   *  with "Restart Request" exists for), and this never touches `last`: only real protocol
   *  events stamp activity. */
  noteTool(active: boolean): void {
    this.toolExecuting = active;
  }

  private tick(): void {
    if (this.isAborted() || this.actionableFired) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    const idle = Date.now() - this.last.atMs;
    if (!this.warned) {
      if (idle >= this.warningMs && !this.toolExecuting) {
        this.warned = true;
        this.hooks.onWarning?.({ elapsedMs: idle, lastActivity: this.last });
      }
    } else if (idle >= this.actionableMs) {
      this.actionableFired = true;
      this.hooks.onActionable?.({ elapsedMs: idle, lastActivity: this.last, hasPartialOutput: this.partialOutput });
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// Whether the host presses Continue itself after a turn. Bounded and progress-gated because an
// unbounded version (2026-09-04 → 05) tripled free-tier spend. Manual Continue stays for the rest.

export const DEFAULT_AUTO_CONTINUE_ROUNDS = 2;

/** What a Continue tells an agent turn. One text, so the button and the bench send the same thing. */
export function continuePrompt(open: string[]): string {
  return 'Continue from where you left off. Keep going with the remaining steps using the work already done above — do not restart or repeat completed steps.'
    + (open.length ? `\n\nStill open:\n${open.map((t) => `- ${t}`).join('\n')}` : '');
}

export interface AutoContinueInput {
  mode: string;
  resumable: boolean;
  cancelled: boolean;
  stopReason?: string;
  changedFiles: number;
  completedBefore: number;
  completedAfter: number;
  used: number;
  max: number;
}

export function shouldAutoContinue(i: AutoContinueInput): boolean {
  if (!i.resumable || i.cancelled || i.mode !== 'agent' || i.stopReason === 'stuck') return false;
  if (i.used >= i.max) return false;
  return i.changedFiles > 0 || i.completedAfter > i.completedBefore;
}

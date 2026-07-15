/* Handler for 'watchdogWarning' / 'watchdogActionable' / 'watchdogDismissed' messages.
 *
 * The watchdog itself (src/agent/sdk.ts) is strictly one-way observability — it emits these
 * and never receives a decision back. A button click here just posts `watchdogAction`; the
 * host decides what it means using capabilities that already exist for other purposes
 * (cancel, re-run, model pinning) — see chatViewProvider.ts's `watchdogAction` case.
 *
 * Non-blocking by design: `watchdogDismissed` removes the notice/card immediately with no
 * user interaction required, matching "only actual protocol events dismiss watchdog UI."
 */

import { send } from '../bridge';

// ----- Types ---------------------------------------------------------------

export interface WatchdogWarningMessage {
  type: 'watchdogWarning';
  requestId: string;
  elapsedMs: number;
  lastActivityLabel?: string;
  lastActivityAgeMs?: number;
}

export interface WatchdogActionableMessage {
  type: 'watchdogActionable';
  requestId: string;
  elapsedMs: number;
  lastActivityLabel?: string;
  lastActivityAgeMs?: number;
  hasPartialOutput: boolean;
}

export interface WatchdogDismissedMessage {
  type: 'watchdogDismissed';
  requestId: string;
}

type WatchdogAction = 'continueWaiting' | 'restartRequest' | 'switchModel' | 'acceptCurrentOutput';

/** Subset of the full Target type this handler needs — the chronological activity feed
 *  (`flow`) to append into, and a lazily-created slot to dedupe warning/actionable/dismissed
 *  into a single element per request ("at most one watchdog notification per active request"). */
export interface Target {
  flow: HTMLElement;
  watchdogEl?: HTMLElement;
}

// ----- Context ---------------------------------------------------------------

export interface WatchdogContext {
  ensureTarget(requestId: string): Target;
  scrollDown(): void;
}

// ----- Helpers ---------------------------------------------------------------

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function activityLine(label?: string, ageMs?: number): string {
  if (!label) return '';
  return ageMs !== undefined ? `Last activity: ${label} — ${fmtElapsed(ageMs)} ago` : `Last activity: ${label}`;
}

function ensureCard(ctx: WatchdogContext, requestId: string): { target: Target; el: HTMLElement } {
  const target = ctx.ensureTarget(requestId);
  if (!target.watchdogEl) {
    const el = document.createElement('div');
    target.flow.appendChild(el);
    target.watchdogEl = el;
  }
  return { target, el: target.watchdogEl };
}

// ----- Handlers ---------------------------------------------------------------

/** Informational only — no buttons, no action implied. */
export function handleWatchdogWarning(ctx: WatchdogContext, msg: WatchdogWarningMessage): void {
  const { el } = ensureCard(ctx, msg.requestId);
  el.className = 'watchdog-notice';
  el.textContent = `No response for ${fmtElapsed(msg.elapsedMs)}. The model may still be working.`;
  el.title = activityLine(msg.lastActivityLabel, msg.lastActivityAgeMs);
  ctx.scrollDown();
}

/** Non-blocking action card: Continue Waiting / Restart Request / Switch Model, plus
 *  Accept Current Output when there's partial output worth keeping. */
export function handleWatchdogActionable(ctx: WatchdogContext, msg: WatchdogActionableMessage): void {
  const { el } = ensureCard(ctx, msg.requestId);
  el.className = 'watchdog-card';
  el.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'watchdog-card-title';
  title.textContent = `No output received for ${fmtElapsed(msg.elapsedMs)}. TierMux cannot determine whether the provider is still executing.`;
  el.appendChild(title);

  const meta = activityLine(msg.lastActivityLabel, msg.lastActivityAgeMs);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'watchdog-card-meta';
    metaEl.textContent = meta;
    el.appendChild(metaEl);
  }

  const actions = document.createElement('div');
  actions.className = 'watchdog-actions';

  const buttons: Array<{ action: WatchdogAction; label: string; primary?: boolean }> = [
    { action: 'continueWaiting', label: 'Continue Waiting', primary: true },
    { action: 'restartRequest', label: 'Restart Request' },
    { action: 'switchModel', label: 'Switch Model' },
  ];
  if (msg.hasPartialOutput) buttons.push({ action: 'acceptCurrentOutput', label: 'Accept Current Output' });

  const choose = (action: WatchdogAction, label: string): void => {
    actions.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = true; });
    const note = document.createElement('div');
    note.className = 'watchdog-card-note';
    note.textContent = action === 'continueWaiting' ? '✓ Continuing to wait…' : `✓ ${label}…`;
    el.appendChild(note);
    // Fire-and-forget — the watchdog itself never awaits a reply; a later `watchdogDismissed`
    // (or a fresh warning/actionable from continued silence) is what updates this card next.
    send({ type: 'watchdogAction', requestId: msg.requestId, action });
  };

  buttons.forEach(({ action, label, primary }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'primary' : 'secondary';
    b.textContent = label;
    b.addEventListener('click', () => choose(action, label));
    actions.appendChild(b);
  });

  el.appendChild(actions);
  ctx.scrollDown();
}

/** A real protocol event arrived — remove the notice/card immediately. No confirmation, no
 *  animation beyond an optional brief fade so the disappearance doesn't read as a glitch. */
export function handleWatchdogDismissed(ctx: WatchdogContext, msg: WatchdogDismissedMessage): void {
  const target = ctx.ensureTarget(msg.requestId);
  const el = target.watchdogEl;
  if (!el) return;
  el.className = 'watchdog-notice';
  el.innerHTML = '';
  el.textContent = '✓ Activity resumed';
  setTimeout(() => {
    if (target.watchdogEl === el) { el.remove(); target.watchdogEl = undefined; }
  }, 2000);
}

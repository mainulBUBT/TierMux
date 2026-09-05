// TodoSheet — the collapsed checklist bar above the composer; clicking it opens a bottom sheet
// with every step and its status. Fed from the live todo list ('todos') and the plan runner's
// progress (planProgress). A run that FINISHES removes the bar after a short linger; a FAILED
// run keeps it pinned with a dismiss × — a failure needs a decision, not a timeout. Host
// interaction via callbacks (onResume) only.

import { el } from '../dom';
import { ICON } from '../../icons';

/** A step's backticked paths become chips — AI Elements' `TaskItemFile`
 *  ("inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-xs").
 *  Plan steps arrive as `Add the check (`app/Models/Item.php`)`, so the paths were already
 *  marked up in the text and were rendering as literal backticks. */
function stepParts(text: string): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let last = 0;
  for (const m of String(text || '').matchAll(/`([^`]+)`/g)) {
    const inner = m[1].trim();
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    // Only path-shaped spans become chips; an inline `variableName` stays plain text.
    out.push(/[/.]/.test(inner) && !/\s/.test(inner)
      ? el('span', { class: 'tm-todosheet-file' }, inner)
      : inner);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

export type TodoSheetStepStatus = 'done' | 'active' | 'pending' | 'failed';

export interface TodoSheetStep {
  text: string;
  status: TodoSheetStepStatus;
}

export interface TodoSheetState {
  title: string;            // "Tasks" (agent checklist) | "Plan" (plan runner)
  steps: TodoSheetStep[];
  /** The run is in progress (spinner on the bar). */
  running?: boolean;
  /** Between "Execute" and the first progress state — the host is switching modes and
   *  spinning up the runner; tell the user to wait instead of showing nothing. */
  preparing?: boolean;
  /** Terminal note (e.g. "Plan completed (5/5 steps)") — replaces the current-step text. */
  note?: string;
  /** Paused plan run → the bar shows a Resume button. */
  paused?: boolean;
  /** Terminal states get a dismiss × and — when nothing failed — self-clear after a short
   *  linger (AUTO_CLEAR_MS). A live run keeps the bar pinned. */
  finished?: boolean;
}

export interface TodoSheetOptions {
  /** Resume a paused plan run (the host restarts it with the saved state). */
  onResume?: () => void;
  /** The run's checklist is gone/aborted → hide the bar entirely. */
  onDismiss?: () => void;
}

/** Status → leading marker, mirroring the Plan card's bullet language. */
const MARKER: Record<TodoSheetStepStatus, string> = {
  done: '✓',
  active: '›',
  pending: '•',
  failed: '✗',
};

/** A finished run keeps the bar only long enough to read its completion note, then clears
 *  itself — a done checklist pinned above the composer forever (until the × is found and
 *  clicked) is leftover scaffolding, not status. Failed runs are exempt: a failure needs a
 *  decision, so that bar stays until the user dismisses it. */
const AUTO_CLEAR_MS = 6000;

export function createTodoSheet(opts: TodoSheetOptions = {}): {
  root: HTMLElement;
  update: (state: TodoSheetState | null) => void;
  open: () => void;
  close: () => void;
} {
  let current: TodoSheetState | null = null;
  let openState = false;
  let autoClearTimer: ReturnType<typeof setTimeout> | undefined;
  let clearAfterClose = false;

  const clearBar = (): void => {
    current = null;
    clearAfterClose = false;
    render();
  };

  const armAutoClear = (state: TodoSheetState): void => {
    if (autoClearTimer) clearTimeout(autoClearTimer);
    autoClearTimer = undefined;
    clearAfterClose = false;
    const cleanFinish = state.finished && !state.paused && !state.running && !state.preparing
      && !state.steps.some((s) => s.status === 'failed');
    if (!cleanFinish) return;
    autoClearTimer = setTimeout(() => {
      autoClearTimer = undefined;
      // Never yank the list out from under an open sheet — finish the read, then clear on close.
      if (openState) { clearAfterClose = true; return; }
      clearBar();
    }, AUTO_CLEAR_MS);
  };

  // The wrapper is the positioning context — the sheet anchors to its top edge.
  const root = el('div', { class: 'tm-todobar-wrap' });

  // The bar itself is the collapse toggle; the sheet slides up from it (popover pattern).
  const bar = el('button', { type: 'button', class: 'tm-todobar hidden', 'aria-expanded': 'false', title: 'Show the checklist' });
  const barIcon = el('span', { class: 'tm-todobar-icon' });
  barIcon.innerHTML = ICON.checkSquare;
  const barCount = el('span', { class: 'tm-todobar-count' });
  const barText = el('span', { class: 'tm-todobar-text', style: 'text-decoration: none;' });
  const barAux = el('span', { class: 'tm-todobar-aux' });
  const barChev = el('span', { class: 'tm-todobar-chev' }, '▴');
  bar.append(barIcon, barCount, barText, barAux, barChev);

  // ── The bottom sheet (anchored above the bar, dropdown-surface styling) ──
  const sheet = el('div', { class: 'tm-todosheet hidden', role: 'dialog', 'aria-label': 'Checklist' });
  const sheetHead = el('div', { class: 'tm-todosheet-head' });
  const sheetTitle = el('span', { class: 'tm-todosheet-title' });
  const sheetCount = el('span', { class: 'tm-todosheet-count' });
  const sheetMin = el('button', { type: 'button', class: 'tm-todosheet-min', title: 'Minimize' }, '▾');
  sheetHead.append(sheetTitle, sheetCount, sheetMin);
  const sheetList = el('div', { class: 'tm-todosheet-list' });
  sheet.append(sheetHead, sheetList);

  const render = (): void => {
    if (!current) { bar.classList.add('hidden'); sheet.classList.add('hidden'); return; }
    const { steps } = current;
    const done = steps.filter(s => s.status === 'done').length;
    const active = steps.find(s => s.status === 'active');
    bar.classList.remove('hidden');
    bar.classList.toggle('running', !!current.running);
    bar.classList.toggle('preparing', !!current.preparing);
    barCount.textContent = steps.length ? `${done}/${steps.length}` : '';
    barText.textContent = current.preparing
      ? 'Preparing to execute the plan — one moment…'
      : current.note ?? (active ? active.text : current.paused ? 'Paused' : '');
    // Paused runs keep their Resume affordance on the bar; finished runs get a dismiss ×.
    barAux.innerHTML = '';
    if (current.paused) {
      const resume = el('button', { type: 'button', class: 'tm-todobar-resume', title: 'Resume the plan run' }, 'Resume');
      resume.addEventListener('click', (e) => { e.stopPropagation(); opts.onResume?.(); });
      barAux.appendChild(resume);
    } else if (current.finished) {
      const close = el('button', { type: 'button', class: 'tm-todobar-close', title: 'Dismiss' }, '×');
      close.addEventListener('click', (e) => { e.stopPropagation(); opts.onDismiss?.(); closeSheet(); });
      barAux.appendChild(close);
    }
    barChev.textContent = openState ? '▾' : '▴';

    sheetTitle.textContent = current.title;
    sheetCount.textContent = steps.length ? `${done}/${steps.length}` : '';
    sheetList.innerHTML = '';
    if (current.preparing) {
      sheetList.appendChild(el('div', { class: 'tm-todosheet-empty' }, 'Starting the agent — the steps will appear here as soon as execution begins.'));
      return;
    }
    if (!steps.length) {
      sheetList.appendChild(el('div', { class: 'tm-todosheet-empty' }, 'No steps yet.'));
      return;
    }
    for (const s of steps) {
      sheetList.appendChild(el('div', { class: `tm-todosheet-step ${s.status}` },
        el('span', { class: `tm-todosheet-marker ${s.status}` }, MARKER[s.status]),
        el('span', { class: 'tm-todosheet-text' }, ...stepParts(s.text)),
      ));
    }
  };

  const closeOnOutside = (e: Event): void => {
    if (!sheet.contains(e.target as Node) && !bar.contains(e.target as Node)) closeSheet();
  };
  function openSheet(): void {
    if (openState) return;
    openState = true;
    sheet.classList.remove('hidden');
    bar.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', closeOnOutside);
    render();
  }
  function closeSheet(): void {
    if (!openState) return;
    openState = false;
    sheet.classList.add('hidden');
    bar.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', closeOnOutside);
    if (clearAfterClose) { clearBar(); return; }
    render();
  }

  bar.addEventListener('click', () => (openState ? closeSheet() : openSheet()));
  sheetMin.addEventListener('click', closeSheet);
  root.append(bar, sheet);

  return {
    root,
    open: openSheet,
    close: closeSheet,
    update(state) {
      current = state;
      if (state) armAutoClear(state);
      else if (autoClearTimer) { clearTimeout(autoClearTimer); autoClearTimer = undefined; clearAfterClose = false; }
      render();
    },
  };
}

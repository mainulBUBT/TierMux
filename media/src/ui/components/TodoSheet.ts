// TodoSheet — the compact checklist bar above the composer, with a slide-up bottom sheet.
//
// The checklist used to render as a one-line truncated banner ("Plan · step 1/7 — …"): it
// SAID things but never showed the list. Now the bar is collapsed by default and the whole
// bar is the toggle — click (or chevron) opens a bottom sheet anchored above the composer
// with every step and its status; the minimize chevron (or clicking the bar again, or
// clicking outside) collapses it back. Fed from BOTH the live agent todo list ('todos') and
// the plan runner's progress state (planProgress) — see main.ts wiring.
//
// Boundary: strict-checked, may only import from media/src/**. Host interaction is via
// callbacks (onResume — the paused plan-run affordance); no send() directly.

import { el } from '../dom';
import { ICON } from '../../icons';

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
  /** Terminal states get a dismiss ×; a live run keeps the bar pinned. */
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

export function createTodoSheet(opts: TodoSheetOptions = {}): {
  root: HTMLElement;
  update: (state: TodoSheetState | null) => void;
  open: () => void;
  close: () => void;
} {
  let current: TodoSheetState | null = null;
  let openState = false;

  // The wrapper is the positioning context — the sheet anchors to its top edge.
  const root = el('div', { class: 'tm-todobar-wrap' });

  // The bar itself is the collapse toggle; the sheet slides up from it (popover pattern).
  const bar = el('button', { type: 'button', class: 'tm-todobar hidden', 'aria-expanded': 'false', title: 'Show the checklist' });
  const barIcon = el('span', { class: 'tm-todobar-icon' });
  barIcon.innerHTML = ICON.checkSquare;
  const barCount = el('span', { class: 'tm-todobar-count' });
  const barText = el('span', { class: 'tm-todobar-text' });
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
        el('span', { class: 'tm-todosheet-text' }, s.text),
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
    render();
  }

  bar.addEventListener('click', () => (openState ? closeSheet() : openSheet()));
  sheetMin.addEventListener('click', closeSheet);
  root.append(bar, sheet);

  return {
    root,
    open: openSheet,
    close: closeSheet,
    update(state) { current = state; render(); },
  };
}

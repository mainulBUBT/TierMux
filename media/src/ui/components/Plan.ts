// Plan component — mirrors Vercel AI Elements "Plan".
//
// A collapsible document card: icon + title + chevron, an optional description paragraph,
// titled sections (e.g. "Key Steps") rendered as a bullet list, and a primary "Build" action.
// One component serves both phases:
//  - mode 'live': read-only bullets with a subtle status marker (✓ / › / •) as execution progresses.
//  - mode 'edit': editable numbered bullets + Build / Discuss / Discard actions (pre-approval).
//
// Boundary: strict-checked, may only import from media/src/**. Host interaction is via callbacks
// (onApprove/onDefer/onDiscard); no send()/renderMarkdown() directly.

import { el } from '../dom';
import { ICON } from '../../icons';

// ========== Types ==========

export type PlanStepStatus = 'complete' | 'active' | 'pending' | 'error';

export interface PlanTask {
  id: string;
  title: string;
  completed: boolean;
  pending?: boolean;
  error?: boolean;
  running?: boolean;
  description?: string;
}

export interface PlanSection {
  id: string;
  title: string;
  tasks: PlanTask[];
}

export interface PlanData {
  id: string;
  title: string;
  description?: string;
  sections: PlanSection[];
  createdAt: number;
  completedTasks: number;
  totalTasks: number;
}

export interface PlanOptions {
  className?: string;
  data: PlanData;
  /** 'live' = read-only execution tracker (default); 'edit' = editable pre-approval proposal. */
  mode?: 'live' | 'edit';
  /** A replayed/already-decided proposal — render read-only with a status note, no actions. */
  settled?: 'discarded' | 'deferred';
  /** Optional summary line (e.g. "3 steps · 2 files"). */
  summary?: string;
  /** edit-mode callbacks. `steps` is the re-serialized (possibly edited) numbered plan text. */
  onApprove?: (steps: string) => void;
  onDefer?: (steps: string) => void;
  onDiscard?: () => void;
  /** Legacy live-mode hooks (kept for compatibility, currently unused by callers). */
  onTaskToggle?: (taskId: string) => void;
  onSave?: () => void;
  onExport?: () => void;
}

// ========== Status helpers ==========

function taskStatus(task: PlanTask): PlanStepStatus {
  if (task.error) return 'error';
  if (task.completed) return 'complete';
  if (task.running) return 'active';
  return 'pending';
}

// Subtle leading marker per status — keeps the document/bullet feel while showing progress.
const STATUS_MARKER: Record<PlanStepStatus, string> = {
  complete: '✓',
  active: '›',
  pending: '•',
  error: '✗',
};

// ========== Bullet step (live mode) ==========

function createBulletStep(task: PlanTask): HTMLElement {
  const status = taskStatus(task);
  return el('li', { class: `tm-plan-step ${status}` },
    el('span', { class: `tm-plan-step-marker ${status}` }, STATUS_MARKER[status]),
    el('span', { class: 'tm-plan-step-text' }, task.title),
  );
}

// ========== Editable bullets (edit mode) ==========
// Ported from the legacy main.ts addPlanRow/renumber/collect so hand-editing before run still
// works, but now lives inside the component.

function addEditableStep(host: HTMLElement, text: string, focus: boolean): HTMLElement {
  const row = el('div', { class: 'tm-plan-step editable' });
  // Plain bullet, not an ordinal number — steps get freely added/removed/reordered while
  // editing, and re-numbering on every change reads as busier than the plain-bullet reference.
  const num = el('span', { class: 'tm-plan-step-num' }, '•');
  const label = el('span', { class: 'tm-plan-step-text', contenteditable: 'plaintext-only' }, text || '');
  label.addEventListener('keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Enter') { ev.preventDefault(); addEditableStep(host, '', true); }
    else if (ev.key === 'Backspace' && !(label.textContent || '').length && host.querySelectorAll('.tm-plan-step').length > 1) {
      ev.preventDefault();
      const prev = row.previousElementSibling as HTMLElement | null;
      row.remove();
      const p = prev && prev.querySelector ? prev.querySelector('.tm-plan-step-text') as HTMLElement | null : null;
      if (p) p.focus();
    }
  });
  // Reject/restore: strikethrough + excluded from collectSteps() while rejected, without
  // losing the text — lets a step be reconsidered instead of only a destructive hard-delete.
  const reject = el('span', { class: 'tm-plan-step-reject', title: 'Reject this step' }, '✗');
  reject.addEventListener('click', () => {
    row.classList.toggle('rejected');
    reject.title = row.classList.contains('rejected') ? 'Restore this step' : 'Reject this step';
  });
  const del = el('span', { class: 'tm-plan-step-del', title: 'Remove' }, '×');
  del.addEventListener('click', () => {
    if (host.querySelectorAll('.tm-plan-step').length > 1) row.remove();
  });
  row.append(num, label, reject, del);
  const addBtn = host.querySelector('.tm-plan-step-add');
  if (addBtn) host.insertBefore(row, addBtn); else host.appendChild(row);
  if (focus) label.focus();
  return row;
}

/** Re-serialize the (possibly edited) rows into a numbered list the host can parse. Rejected
 *  rows are dropped here, not on click, so a step can be un-rejected right up until Build/Discuss. */
function collectSteps(host: HTMLElement): string {
  const out: string[] = [];
  host.querySelectorAll('.tm-plan-step').forEach(row => {
    if (row.classList.contains('rejected')) return;
    const t = (row.querySelector('.tm-plan-step-text')?.textContent || '').trim();
    if (t) out.push(t);
  });
  return out.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

// ========== Parsing helpers (exported for main.ts) ==========

export function parsePlanSteps(steps: string): string[] {
  const items: string[] = [];
  for (const line of String(steps || '').split('\n')) {
    const mm = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (mm) { const tx = mm[1].replace(/\*\*/g, '').trim(); if (tx) items.push(tx); }
  }
  if (!items.length) { const t = String(steps || '').trim(); if (t) items.push(t); }
  return items;
}

const EXTENSIONLESS_FILENAMES = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'artisan', 'license', 'changelog']);

export function detectStepFiles(text: string): string[] {
  const files: string[] = [];
  const spans = String(text || '').match(/`([^`]+)`/g) || [];
  for (const span of spans) {
    const inner = span.slice(1, -1).trim();
    if (!inner || /\s/.test(inner)) continue;
    const base = inner.split('/').pop() || inner;
    const looksLikePath = inner.includes('/') || /^\.\w/.test(inner) || /\w\.\w+$/.test(inner) || EXTENSIONLESS_FILENAMES.has(base.toLowerCase());
    if (looksLikePath) files.push(inner);
  }
  return files;
}

function tasksFromStepText(stepsText: string): PlanTask[] {
  return parsePlanSteps(stepsText).map((title, i) => ({
    id: `step-${i + 1}`, title, completed: false, pending: true,
  }));
}

// Meta-commentary a model writes about the reply itself rather than the plan — stripped from
// the front of the description regardless of prompt instructions, since those aren't reliably
// followed by every model. Matched greedily up to the first sentence boundary so "You're in plan
// mode. This adds dark mode…" becomes "This adds dark mode…", not left half-stripped.
const META_PREAMBLE = /^(you'?re|you are)\s+in\s+\w+\s+mode\.?\s*|^here'?s?\s+(is\s+)?the\s+plan:?\s*|^this\s+plan\s+will\s*/i;

/** The prose before the first list item, if the model wrote one (a lead-in paragraph
 *  explaining the plan) — markdown headings/bold stripped. Returns undefined when the plan
 *  text starts straight into steps, which is common and not an error. */
function extractPlanDescription(stepsText: string): string | undefined {
  const lines: string[] = [];
  for (const line of String(stepsText || '').split('\n')) {
    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) break; // first step line — everything before is intro
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed)) continue; // skip blank lines and markdown headings
    lines.push(trimmed.replace(/\*\*/g, ''));
  }
  let description = lines.join(' ').trim();
  // Strip one or two leading meta-preamble clauses (a model sometimes chains "You're in plan
  // mode. This plan will X:") and any trailing colon left from a "...the following steps:" lead-in.
  description = description.replace(META_PREAMBLE, '').replace(META_PREAMBLE, '').trim();
  description = description.replace(/:\s*$/, '.').trim();
  if (description) description = description[0].toUpperCase() + description.slice(1);
  return description || undefined;
}

/** Build PlanData + a summary line from raw plan text (planProposed.steps). */
export function planDataFromStepText(title: string, stepsText: string): { data: PlanData; summary: string } {
  const tasks = tasksFromStepText(stepsText);
  const description = extractPlanDescription(stepsText);
  const fileCount = new Set(tasks.flatMap(t => detectStepFiles(t.title))).size;
  const summary = `${tasks.length} step${tasks.length === 1 ? '' : 's'}` + (fileCount ? ` · ${fileCount} file${fileCount === 1 ? '' : 's'}` : '');
  return {
    summary,
    data: {
      id: `plan-propose-${Date.now()}`,
      title, description, createdAt: Date.now(),
      sections: [{ id: 'steps', title: 'Key Steps', tasks }],
      totalTasks: tasks.length, completedTasks: 0,
    },
  };
}

/** Build PlanData from the agent's live Todo list (case 'todos'). */
export function planDataFromTodos(title: string, todos: { status: 'completed' | 'in_progress' | 'pending'; content: string }[]): PlanData {
  const tasks: PlanTask[] = todos.map((t, i) => ({
    id: `todo-${i + 1}`, title: t.content,
    completed: t.status === 'completed',
    running: t.status === 'in_progress',
    pending: t.status === 'pending',
  }));
  const completed = tasks.filter(t => t.completed).length;
  return {
    id: `plan-todos-${Date.now()}`, title, createdAt: Date.now(),
    sections: [{ id: 'steps', title: 'Tasks', tasks }],
    totalTasks: tasks.length, completedTasks: completed,
  };
}

// ========== Action row (edit mode) ==========

function createActions(host: HTMLElement, opts: PlanOptions): HTMLElement {
  const actions = el('div', { class: 'tm-plan-actions' });
  // "Save", not "Build" — this only writes the plan to a file now; it never executes it (see
  // handleApprovePlan in chatViewProvider.ts). "Build" was the label from when clicking this
  // also auto-ran the agent; keeping that name after that behavior was removed would be
  // actively misleading about what the button does.
  const buildIcon = el('span', { class: 'tm-plan-action-icon' });
  buildIcon.innerHTML = ICON.save;
  const build = el('button', { class: 'tm-plan-action primary', type: 'button', title: 'Save the plan to a file — switch to Agent mode to execute it' },
    'Save', buildIcon);
  const discuss = el('button', { class: 'tm-plan-action', type: 'button', title: 'Keep talking — nothing saved or run yet' }, 'Discuss');
  const discard = el('button', { class: 'tm-plan-action danger', type: 'button' }, 'Discard');
  // Every step can now be individually rejected — guard against silently sending an empty plan
  // (e.g. every step got rejected/deleted) instead of quietly saving a plan with nothing in it.
  const warnEmpty = () => {
    if (host.querySelector('.tm-plan-empty-warning')) return;
    const note = el('div', { class: 'tm-plan-empty-warning' }, 'No steps left — restore or add one before saving.');
    host.insertAdjacentElement('afterend', note);
    setTimeout(() => note.remove(), 3000);
  };
  build.addEventListener('click', () => {
    const steps = collectSteps(host);
    if (!steps.trim()) { warnEmpty(); return; }
    actions.remove();
    opts.onApprove?.(steps);
  });
  discuss.addEventListener('click', () => { discuss.remove(); discard.remove(); opts.onDefer?.(collectSteps(host)); });
  discard.addEventListener('click', () => { actions.remove(); opts.onDiscard?.(); });
  actions.append(build, discuss, discard);
  return actions;
}

// ========== Main component ==========

export function createPlan(opts: PlanOptions): HTMLElement {
  const { className, data, mode = 'live', settled, summary } = opts;
  const editable = mode === 'edit' && !settled;
  const description = opts.data.description;

  const plan = el('div', {
    class: `tm-plan mode-${mode}${settled ? ` settled ${settled}` : ''}${className ? ` ${className}` : ''}`.trim(),
    dataset: { id: data.id },
  });

  // Header — icon + title + chevron (right). Click toggles `.collapsed`.
  const header = el('div', { class: 'tm-plan-header' },
    el('span', { class: 'tm-plan-icon' }, '▤'),
    el('span', { class: 'tm-plan-title' }, data.title),
    el('span', { class: 'tm-plan-chevron' }, '▾'),
  );
  plan.appendChild(header);

  // Always visible regardless of collapse state — title + description + status note stay
  // readable at a glance; only the step list/actions below fold away.
  const always = el('div', { class: 'tm-plan-always' });
  if (settled) {
    always.appendChild(el('div', { class: `tm-plan-settled ${settled}` },
      settled === 'discarded' ? '✗ Discarded' : '— Kept for discussion, never run —'));
  }
  if (description) always.appendChild(el('p', { class: 'tm-plan-description' }, description));
  if (summary && !settled) always.appendChild(el('div', { class: 'tm-plan-summary' }, summary));
  plan.appendChild(always);

  const body = el('div', { class: 'tm-plan-content' });

  // Sections — titled bullet lists (Vercel "Key Steps").
  data.sections.forEach(section => {
    if (!section.tasks.length && !editable) return;
    const sec = el('section', { class: 'tm-plan-section' });
    sec.appendChild(el('h4', { class: 'tm-plan-section-title' }, section.title));
    const list = el('div', { class: 'tm-plan-step-list' });
    if (editable) {
      const addBtn = el('div', { class: 'tm-plan-step tm-plan-step-add' }, '+ Add step');
      addBtn.addEventListener('click', () => addEditableStep(list, '', true));
      list.appendChild(addBtn);
      const seed = section.tasks.map(t => t.title);
      (seed.length ? seed : ['']).forEach(t => addEditableStep(list, t, false));
    } else {
      section.tasks.forEach(task => list.appendChild(createBulletStep(task)));
    }
    sec.appendChild(list);
    body.appendChild(sec);
  });

  if (editable) body.appendChild(createActions(body.querySelector('.tm-plan-step-list') as HTMLElement, opts));

  plan.appendChild(body);

  header.addEventListener('click', () => plan.classList.toggle('collapsed'));

  return plan;
}

// ========== Legacy utilities (re-exported, kept for compatibility) ==========

export function createPlanFromTasks(title: string, tasks: PlanTask[]): PlanData {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.completed).length;
  return {
    id: `plan-${Date.now()}`, title,
    sections: [{ id: 'default', title: 'Tasks', tasks }],
    createdAt: Date.now(), totalTasks, completedTasks,
  };
}

export function updatePlanProgress(data: PlanData): PlanData {
  const totalTasks = data.sections.reduce((s, sec) => s + sec.tasks.length, 0);
  const completedTasks = data.sections.reduce((s, sec) => s + sec.tasks.filter(t => t.completed).length, 0);
  return { ...data, totalTasks, completedTasks };
}

export function togglePlanTask(data: PlanData, taskId: string): PlanData {
  const sections = data.sections.map(sec => ({
    ...sec,
    tasks: sec.tasks.map(t => t.id === taskId ? { ...t, completed: !t.completed } : t),
  }));
  return updatePlanProgress({ ...data, sections });
}

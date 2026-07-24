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
  const num = el('span', { class: 'tm-plan-step-num' }, `${host.querySelectorAll('.tm-plan-step').length + 1}.`);
  const label = el('span', { class: 'tm-plan-step-text', contenteditable: 'plaintext-only' }, text || '');
  label.addEventListener('keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Enter') { ev.preventDefault(); addEditableStep(host, '', true); }
    else if (ev.key === 'Backspace' && !(label.textContent || '').length && host.querySelectorAll('.tm-plan-step').length > 1) {
      ev.preventDefault();
      const prev = row.previousElementSibling as HTMLElement | null;
      row.remove();
      renumber(host);
      const p = prev && prev.querySelector ? prev.querySelector('.tm-plan-step-text') as HTMLElement | null : null;
      if (p) p.focus();
    }
  });
  const del = el('span', { class: 'tm-plan-step-del', title: 'Remove' }, '×');
  del.addEventListener('click', () => {
    if (host.querySelectorAll('.tm-plan-step').length > 1) { row.remove(); renumber(host); }
  });
  row.append(num, label, del);
  const addBtn = host.querySelector('.tm-plan-step-add');
  if (addBtn) host.insertBefore(row, addBtn); else host.appendChild(row);
  if (focus) label.focus();
  return row;
}

function renumber(host: HTMLElement): void {
  host.querySelectorAll('.tm-plan-step .tm-plan-step-num').forEach((ic, i) => {
    (ic as HTMLElement).textContent = `${i + 1}.`;
  });
}

/** Re-serialize the (possibly edited) rows into a numbered list the host can parse. */
function collectSteps(host: HTMLElement): string {
  const out: string[] = [];
  host.querySelectorAll('.tm-plan-step .tm-plan-step-text').forEach(elNode => {
    const t = (elNode.textContent || '').trim();
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

/** Build PlanData + a summary line from raw plan text (planProposed.steps). */
export function planDataFromStepText(title: string, stepsText: string): { data: PlanData; summary: string } {
  const tasks = tasksFromStepText(stepsText);
  const fileCount = new Set(tasks.flatMap(t => detectStepFiles(t.title))).size;
  const summary = `${tasks.length} step${tasks.length === 1 ? '' : 's'}` + (fileCount ? ` · ${fileCount} file${fileCount === 1 ? '' : 's'}` : '');
  return {
    summary,
    data: {
      id: `plan-propose-${Date.now()}`,
      title, createdAt: Date.now(),
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
  const build = el('button', { class: 'tm-plan-action primary', type: 'button', title: 'Save the plan file and execute it step by step' },
    'Build', el('span', { class: 'tm-plan-action-icon' }, '↻'));
  const discuss = el('button', { class: 'tm-plan-action', type: 'button', title: 'Keep talking — nothing saved or run yet' }, 'Discuss');
  const discard = el('button', { class: 'tm-plan-action danger', type: 'button' }, 'Discard');
  build.addEventListener('click', () => { actions.remove(); opts.onApprove?.(collectSteps(host)); });
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

  const body = el('div', { class: 'tm-plan-content' });

  if (settled) {
    body.appendChild(el('div', { class: `tm-plan-settled ${settled}` },
      settled === 'discarded' ? '✗ Discarded' : '— Kept for discussion, never run —'));
  }
  if (description) body.appendChild(el('p', { class: 'tm-plan-description' }, description));
  if (summary && !settled) body.appendChild(el('div', { class: 'tm-plan-summary' }, summary));

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

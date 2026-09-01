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

/** One open question carried on the plan. Non-empty `questions` ⇒ the plan is not executable
 *  until every one is answered — the plan and the doubt ship together instead of the model
 *  having to choose between asking and planning. */
export interface PlanQuestion {
  text: string;
  background?: string;
  options?: string[];
  /** The user's pick, once made on the card. */
  answer?: string;
}

export interface PlanData {
  id: string;
  title: string;
  description?: string;
  /** The reading of the request these steps implement — rendered above everything else. */
  reading?: string;
  /** Why this approach, and what it affects beyond the changed lines. */
  approach?: string;
  questions?: PlanQuestion[];
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
  /** Save the plan AND immediately execute it: switch to Agent mode and run. Distinct from
   *  `onApprove` (Save), which only writes the plan to a file. */
  onExecute?: (steps: string) => void;
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
  const steps = out.map((s, i) => `${i + 1}. ${s}`).join('\n');
  // The header block rides back out with the steps: this string IS what gets saved to the plan
  // file and re-parsed (planStructurer.renderPlanMarkdown), so dropping it here would silently
  // lose the reading, the approach and the answers the user just gave.
  const head: string[] = [];
  const reading = host.querySelector('.tm-plan-reading .tm-plan-meta-text')?.textContent?.trim();
  const approach = host.querySelector('.tm-plan-approach .tm-plan-meta-text')?.textContent?.trim();
  if (reading) head.push(`Reading: ${reading}`);
  if (approach) head.push(`Approach: ${approach}`);
  host.querySelectorAll('.tm-plan-question').forEach(row => {
    const text = row.querySelector('.tm-plan-question-text')?.textContent?.trim();
    if (!text) return;
    const bg = row.querySelector('.tm-plan-question-bg')?.textContent?.trim();
    const opts = [...row.querySelectorAll('.tm-plan-question-option')].map(o => o.textContent?.trim()).filter(Boolean);
    const parts = [text, bg || '', opts.join('; ')];
    while (parts.length && !parts[parts.length - 1]) parts.pop();
    head.push(`Q: ${parts.join(' | ')}`);
    const answer = (row as HTMLElement).dataset.answer;
    if (answer) head.push(`A: ${answer}`);
  });
  return head.length ? `${head.join('\n')}\n\n${steps}` : steps;
}

// ========== Parsing helpers (exported for main.ts) ==========

// Edit-verb prefixes and a path detector — mirror titles.ts planStepsToTodos' fourth branch so
// the card renders the same steps the host detected. Kept inline (not imported) because the
// webview bundle may only import from media/src/** and src/shared/**.
// The plan's header block, mirroring src/agent/planStructurer.ts's CARD_*_RE. These lines carry
// the reading, the approach and any open questions; they must never be mistaken for steps —
// `Approach: the fix goes in app/Models/Item.php` would otherwise match the bare-imperative
// branch below (edit verb + path) and render as a step the user could "reject".
const PLAN_HEADER_LINE = /^\s*(?:Reading|Approach|Q|A):\s*/;

const PLAN_EDIT_VERB = /^(add|create|implement|build|writ|fix|refactor|rename|move|delete|remove|updat|chang|modif|edit|replac|wir|integrat|convert|migrat|install|configur|extract|split|merg|append|insert|expos|export|hook|connect|introduc|switch|drop|bump|upgrad|enabl|disabl|set ?up|scaffold|register|inject|guard|validat|sync|audit|document|correct|review|ensur|verify|test|apply|enforce|generat)\w*\b/i;
const PLAN_PATHISH = /[\w./-]+\.[a-z]{1,6}\b|\b[\w-]+\/[\w-]+/;

export function parsePlanSteps(steps: string): string[] {
  const items: string[] = [];
  for (const line of String(steps || '').split('\n')) {
    if (PLAN_HEADER_LINE.test(line)) continue;
    const mm = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (mm) { const tx = mm[1].replace(/\*\*/g, '').trim(); if (tx) items.push(tx); continue; }
    // Bare imperative paragraph line naming a file — the "Create/Add/Update <file>" plan format
    // weak models emit with no list markers. Without this the whole plan collapsed into one item.
    const tr = line.trim();
    if (tr && PLAN_EDIT_VERB.test(tr) && PLAN_PATHISH.test(tr)) { const tx = tr.replace(/\*\*/g, '').trim(); if (tx) items.push(tx); }
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
    if (PLAN_HEADER_LINE.test(line)) continue;          // header block renders as its own blocks
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
/** Split the `Reading:` / `Approach:` / `Q:` / `A:` header block out of the card text. `A:` lines
 *  attach to the question directly above them, which is where the card writes them back. */
export function parsePlanHeader(stepsText: string): { reading?: string; approach?: string; questions: PlanQuestion[] } {
  let reading: string | undefined;
  let approach: string | undefined;
  const questions: PlanQuestion[] = [];
  for (const raw of String(stepsText || '').split('\n')) {
    const line = raw.trim();
    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(raw)) break; // header block ends at the first step
    const r = line.match(/^Reading:\s*(.+)$/);
    if (r) { reading = r[1].trim(); continue; }
    const a = line.match(/^Approach:\s*(.+)$/);
    if (a) { approach = a[1].trim(); continue; }
    const q = line.match(/^Q:\s*(.+)$/);
    if (q) {
      const [text, background, options] = q[1].split('|').map(x => x.trim());
      if (text) questions.push({
        text,
        background: background || undefined,
        options: options ? options.split(';').map(o => o.trim()).filter(Boolean) : undefined,
      });
      continue;
    }
    const ans = line.match(/^A:\s*(.+)$/);
    if (ans && questions.length) questions[questions.length - 1].answer = ans[1].trim();
  }
  return { reading, approach, questions };
}

export function planDataFromStepText(title: string, stepsText: string): { data: PlanData; summary: string } {
  const tasks = tasksFromStepText(stepsText);
  const description = extractPlanDescription(stepsText);
  const { reading, approach, questions } = parsePlanHeader(stepsText);
  const fileCount = new Set(tasks.flatMap(t => detectStepFiles(t.title))).size;
  const open = questions.filter(q => !q.answer).length;
  const summary = `${tasks.length} step${tasks.length === 1 ? '' : 's'}`
    + (fileCount ? ` · ${fileCount} file${fileCount === 1 ? '' : 's'}` : '')
    + (open ? ` · ${open} open question${open === 1 ? '' : 's'}` : '');
  return {
    summary,
    data: {
      id: `plan-propose-${Date.now()}`,
      title, description, reading, approach, createdAt: Date.now(),
      questions: questions.length ? questions : undefined,
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

// ========== Open questions ==========

/** Renders the plan's open questions as answerable chips. Answering is what UNLOCKS Execute/Save:
 *  the plan and the model's doubt arrive together, and the card refuses to run a plan whose
 *  premises are still guesses. Free-text answers are allowed — a question is often not a choice
 *  between the two options the model imagined. */
function createQuestions(plan: HTMLElement, questions: PlanQuestion[], editable: boolean): HTMLElement {
  const box = el('div', { class: 'tm-plan-questions' });
  box.appendChild(el('div', { class: 'tm-plan-questions-title' },
    `⚠ ${questions.length} open question${questions.length === 1 ? '' : 's'} — answer to enable Execute`));
  questions.forEach((q, i) => {
    const row = el('div', { class: 'tm-plan-question', dataset: { index: String(i) } });
    row.appendChild(el('div', { class: 'tm-plan-question-text' }, q.text));
    if (q.background) row.appendChild(el('div', { class: 'tm-plan-question-bg' }, q.background));
    const answer = el('div', { class: 'tm-plan-question-answer' });
    if (q.answer) answer.textContent = q.answer;
    const pick = (value: string) => {
      answer.textContent = value;
      row.dataset.answer = value;
      row.classList.add('answered');
      refreshGate(plan);
    };
    if (editable) {
      const chips = el('div', { class: 'tm-plan-question-options' });
      (q.options ?? []).forEach(opt => {
        const chip = el('button', { class: 'tm-plan-question-option', type: 'button' }, opt);
        chip.addEventListener('click', () => {
          chips.querySelectorAll('.tm-plan-question-option').forEach(c => c.classList.remove('selected'));
          chip.classList.add('selected');
          pick(opt);
        });
        if (q.answer === opt) chip.classList.add('selected');
        chips.appendChild(chip);
      });
      const free = el('input', { class: 'tm-plan-question-free', type: 'text', placeholder: 'or type an answer…' }) as HTMLInputElement;
      free.value = q.answer && !(q.options ?? []).includes(q.answer) ? q.answer : '';
      free.addEventListener('input', () => {
        if (!free.value.trim()) { delete row.dataset.answer; row.classList.remove('answered'); refreshGate(plan); return; }
        chips.querySelectorAll('.tm-plan-question-option').forEach(c => c.classList.remove('selected'));
        pick(free.value.trim());
      });
      row.append(chips, free);
    }
    if (q.answer) { row.dataset.answer = q.answer; row.classList.add('answered'); }
    row.appendChild(answer);
    box.appendChild(row);
  });
  return box;
}

/** Enable/disable the run buttons from the current answer state. Called on every pick. */
function refreshGate(plan: HTMLElement): void {
  const open = [...plan.querySelectorAll('.tm-plan-question')].filter(r => !(r as HTMLElement).dataset.answer).length;
  plan.querySelectorAll('.tm-plan-action.gated').forEach(btn => {
    (btn as HTMLButtonElement).disabled = open > 0;
    (btn as HTMLButtonElement).title = open > 0
      ? `Answer the ${open} open question${open === 1 ? '' : 's'} first`
      : (btn as HTMLButtonElement).dataset.title || '';
  });
  const note = plan.querySelector('.tm-plan-questions-title');
  if (note) note.textContent = open
    ? `⚠ ${open} open question${open === 1 ? '' : 's'} — answer to enable Execute`
    : '✓ All questions answered';
}

// ========== Action row (edit mode) ==========

function createActions(host: HTMLElement, opts: PlanOptions): HTMLElement {
  const actions = el('div', { class: 'tm-plan-actions' });
  // Two primary affordances:
  //  - Execute: save the plan AND run it now (switch to Agent mode, auto-launch). This is the
  //    "do it" button — the explicit execute-or-not choice the flow was missing.
  //  - Save: write the plan to a file only; the user runs it later by switching to Agent.
  // "Save", not "Build", because it no longer auto-runs — Execute is the run path now.
  const execIcon = el('span', { class: 'tm-plan-action-icon' });
  execIcon.innerHTML = ICON.zap;
  const execute = el('button', { class: 'tm-plan-action primary gated', type: 'button', title: 'Save the plan and start executing it in Agent mode now' },
    'Execute', execIcon);
  execute.dataset.title = execute.title;
  const buildIcon = el('span', { class: 'tm-plan-action-icon' });
  buildIcon.innerHTML = ICON.save;
  // Save is gated too: a plan file written with its premises still guessed is a plan that will
  // be executed later, from Agent mode, with nobody left to catch the guess.
  const build = el('button', { class: 'tm-plan-action gated', type: 'button', title: 'Save the plan to a file — execute it later from Agent mode' },
    'Save', buildIcon);
  build.dataset.title = build.title;
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
  execute.addEventListener('click', () => {
    const steps = collectSteps(host);
    if (!steps.trim()) { warnEmpty(); return; }
    actions.remove();
    opts.onExecute?.(steps);
  });
  build.addEventListener('click', () => {
    const steps = collectSteps(host);
    if (!steps.trim()) { warnEmpty(); return; }
    actions.remove();
    opts.onApprove?.(steps);
  });
  discuss.addEventListener('click', () => { discuss.remove(); discard.remove(); opts.onDefer?.(collectSteps(host)); });
  discard.addEventListener('click', () => { actions.remove(); opts.onDiscard?.(); });
  actions.append(execute, build, discuss, discard);
  // Reflect the initial answer state — a plan that arrives with open questions starts locked.
  setTimeout(() => refreshGate(host), 0);
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

  // Header — icon + title + collapse trigger (right), matching AI Elements' PlanHeader
  // (`CardHeader`, `flex items-start justify-between`) and its PlanTrigger (a ghost icon button
  // carrying ChevronsUpDownIcon). The whole row stays clickable rather than only the button:
  // that is a usability addition, not a divergence in look.
  const planIcon = el('span', { class: 'tm-plan-icon' });
  planIcon.innerHTML = ICON.doc;
  const planChevron = el('span', { class: 'tm-plan-chevron', 'aria-hidden': 'true' });
  planChevron.innerHTML = ICON.chevronsUpDown;
  const header = el('div', { class: 'tm-plan-header' },
    planIcon,
    el('span', { class: 'tm-plan-title' }, data.title),
    planChevron,
  );
  plan.appendChild(header);

  // Always visible regardless of collapse state — title + description + status note stay
  // readable at a glance; only the step list/actions below fold away.
  const always = el('div', { class: 'tm-plan-always' });
  if (settled) {
    always.appendChild(el('div', { class: `tm-plan-settled ${settled}` },
      settled === 'discarded' ? '✗ Discarded' : '— Kept for discussion, never run —'));
  }
  // The reading sits ABOVE the description and stays visible when the card is collapsed: a plan
  // can be right in every step and still implement the wrong request, and that is only catchable
  // if the premise is the first thing read (2026-09-01 vendor-order repro, where an inverted
  // requirement hid behind two individually-defensible steps).
  // No "Reading" label: the sentence reads as the plan's own opening line, which is what
  // AI Elements' PlanDescription does too. The label only named what the sentence already is.
  // (The `Reading:` prefix stays in the CARD TEXT — that is the serialization the saved
  // document and collectSteps parse; it is not what the user reads.)
  if (data.reading) {
    always.appendChild(el('div', { class: 'tm-plan-reading' },
      el('span', { class: 'tm-plan-meta-text' }, data.reading)));
  }
  if (data.approach) {
    always.appendChild(el('div', { class: 'tm-plan-approach' },
      el('span', { class: 'tm-plan-meta-label' }, 'Approach'),
      el('span', { class: 'tm-plan-meta-text' }, data.approach)));
  }
  if (description) always.appendChild(el('p', { class: 'tm-plan-description' }, description));
  if (data.questions?.length && !settled) always.appendChild(createQuestions(plan, data.questions, editable));
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

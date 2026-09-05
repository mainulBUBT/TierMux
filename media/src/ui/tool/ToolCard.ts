/* Tool card and status rendering utilities.
 *
 * Moved from media/src/toolRendering.ts as the first component to move into ui/** —
 * "already partially separated," now built on the ui/primitives/Collapse factory for
 * its two <details><summary>…</summary>…</details> blocks instead of hand-rolling that
 * structure twice. Output markup/classes are unchanged from before this move.
 * 
 * Enhanced with AI Elements design patterns for better UX and visual hierarchy.
 */

import { renderMarkdown } from '../../markdown';
import { fmtDuration, fmtToolDuration } from '../../format';
import { el } from '../dom';
import { createCollapse } from '../primitives/Collapse';
import { unifiedDiff } from '../../format/unifiedDiff';

// ========== Constants ==========

/** Shared live/settled status glyph: a spinning ring while something is actually running,
 *  swapped for a static mark once it settles. One glyph vocabulary for "something is
 *  running" across the whole transcript — reasoning (buildReasoningBlock) and a grouped
 *  tool row (buildToolGroupRow) both use it, instead of each carrying its own separate
 *  status-indicator identity (a brain icon, a colored dot, ...). CSS lives in tool-card.css
 *  (.tm-spin-glyph / -ring / -mark), loaded before every other component stylesheet that
 *  might use this. */
function buildSpinGlyph(live: boolean, mark: string, variant?: 'success' | 'error'): HTMLElement {
  return el('span', { class: `tm-spin-glyph${live ? ' live' : ''}${variant ? ` ${variant}` : ''}`, 'aria-hidden': 'true' },
    el('i', { class: 'tm-spin-glyph-ring' }),
    el('i', { class: 'tm-spin-glyph-mark' }, mark),
  );
}

/** The leading status glyph for ONE tool row: spinner while running, green ✓ once settled,
 *  red ✗ on error — the SAME tick vocabulary the grouped read rows use, extended to every
 *  tool card (webSearch/fetchUrl/delegateTask/edits/…) so the whole timeline reads like the
 *  reference rows ("✓ Read …"). Replaces the per-tool glyph (⊙/◎/⊞) that used to sit here:
 *  state, not tool identity, is what the leading slot should communicate. Used by BOTH the
 *  static card (createToolHeader) and the live upsert (main.ts), so the two can't drift. */
export function toolStateGlyph(state?: 'running' | 'done' | 'error' | 'queued'): HTMLElement {
  if (state === 'running' || state === 'queued') return buildSpinGlyph(true, '');
  if (state === 'error') return buildSpinGlyph(false, '✗', 'error');
  return buildSpinGlyph(false, '✓', 'success');
}

// ── Edit-diff preview thresholds (Chat-UX-parity plan; boundary-tested in scripts/toolDiff.e2e.ts).
// A change under BOTH inline caps renders as a rich diff2html view directly in the card body;
// between the inline caps and the preview ceiling it renders collapsed behind a <details>;
// at/over the ceiling only a summary line is shown (the saved file itself is always the
// source of truth). ──
/** Changed lines below which the diff renders expanded inline. */
export const INLINE_DIFF_MAX_CHANGED_LINES = 400;
/** Diff byte size below which the diff renders expanded inline (CRLF normalized first). */
export const INLINE_DIFF_MAX_BYTES = 50 * 1024;
/** Changed lines above which no full diff is rendered at all — just a summary note. */
export const DIFF_PREVIEW_MAX_CHANGED_LINES = 2000;

// ========== Structure ==========

/** The `.tm-tool-card-header` row: state glyph + title + hint + duration + actions.
 *  The leading slot is the STATE tick (toolStateGlyph), not a per-tool glyph — every row in
 *  the timeline reads "✓ Searched …" / "✓ Fetched …" the way the grouped read rows do. */
function createToolHeader(title: string, hint: string, state: 'running' | 'done' | 'error' | 'queued', onRetry?: () => void, onCancel?: () => void, durationMs?: number): HTMLElement {
  // No "Running"/"Completed"/"Error" text badge — the design artifact conveys state purely
  // through the tick's colour (tool-card.css's .tm-tool-card.running/.done/.error), the same
  // "spend boldness in one place, let colour/shape carry the rest" principle the composer's
  // send button follows. Only the duration stays as text, since a colour can't say "0.4s".
  const durationLabel = durationMs != null && durationMs > 0 && (state === 'done' || state === 'error')
    ? fmtToolDuration(durationMs) : '';

  return el('div', { class: 'tm-tool-card-header' },
    el('div', { class: 'tm-tool-card-info' },
      el('span', { class: 'tm-tool-card-icon' }, toolStateGlyph(state)),
      el('span', { class: 'tm-tool-card-title' }, title),
      hint ? el('span', { class: 'tm-tool-card-hint' }, hint) : null
    ),
    durationLabel ? el('span', { class: 'tm-tool-card-duration' }, `· ${durationLabel}`) : null,
    el('span', { class: 'tm-tool-card-chevron', 'aria-hidden': 'true' }, '▾'),
    el('div', { class: 'tm-tool-card-actions' },
      state === 'error' && onRetry ? el('button', {
        class: 'tm-tool-card-btn',
        title: 'Retry',
        onClick: onRetry
      }, '↻') : null,
      state === 'running' && onCancel ? el('button', {
        class: 'tm-tool-card-btn',
        title: 'Cancel',
        onClick: onCancel
      }, '✕') : null
    )
  );
}

/** The collapsible `.tm-tool-card-body` output/diff block. Returns both the <details> element
 *  (to append to the card) and its inner <pre> (for the diff/output content the caller
 *  fills in afterward — the exact content depends on the tool, decided by buildToolCard).
 *  Enhanced with AI Elements patterns for better UX. */
function createToolBody(): { el: HTMLDetailsElement; pre: HTMLPreElement; } {
  const pre = el('pre');
  const more = createCollapse({ 
    className: 'tm-tool-card-body hidden', 
    summary: 'View output',
    body: pre 
  });
  return { el: more, pre };
}

// ========== Public API ==========

/**
 * Build a reasoning/thinking block for display in the tool flow.
 * Used for both live "Thinking" blocks and static "Thought" cards.
 * Enhanced with AI Elements Reasoning component patterns.
 */
export function buildReasoningBlock(text: string, tc?: string, isStreaming?: boolean, durationMs?: number): HTMLElement {
  const block = el('div', {
    class: `tm-reasoning ${isStreaming ? 'streaming open' : ''}`,
    dataset: { live: isStreaming ? '1' : '0', streaming: isStreaming ? 'true' : 'false', ...(tc ? { tc } : {}) },
  });

  // Vercel AI Elements "Reasoning" trigger: brain glyph + "Thinking…" while live,
  // "Thought for 42s / 3m 2s / 1hr 2m" once settled (durationMs from the host). Chevron rotates on open.
  const durationLabel = !isStreaming && durationMs && durationMs > 0
    ? `Thought for ${fmtDuration(Math.max(1, durationMs / 1000))}`
    : isStreaming ? 'Thinking' : 'Thought';

  const glyph = buildSpinGlyph(!!isStreaming, '•');
  const header = el('div', { class: 'tm-reasoning-header' },
    el('div', { class: 'tm-reasoning-title' },
      glyph,
      el('span', { class: 'tm-reasoning-label' }, durationLabel),
    ),
    el('span', { class: 'tm-reasoning-chevron' }, '▾'),
  );
  block.appendChild(header);

  // Collapsible content area — the muted reasoning card.
  const content = el('div', { class: 'tm-reasoning-content' });
  const body = el('div', { class: 'tm-reasoning-body tm-reasoning-text' }, renderMarkdown(text || ''));
  content.appendChild(body);
  block.appendChild(content);

  header.addEventListener('click', () => {
    const open = block.classList.toggle('open');
    // Remember a deliberate open so the 1s auto-collapse above does not undo it.
    if (open) block.dataset.userOpen = '1'; else delete block.dataset.userOpen;
  });

  return block;
}

/** Update an existing reasoning block in place: refresh its text, and on done settle the
 *  streaming state + "Thought for Ns" label. Mirrors how `upsertTool` reconciles tool cards.
 *
 *  Reasoning is split into per-segment blocks (`reason-${requestId}-${seg}` — see chatViewProvider's
 *  onReasoning/endReasoningSegment): a tool call ends the current segment and the next thinking burst
 *  opens a fresh block, giving a think→tool→think timeline. Within a single segment this still updates
 *  one block in place: refresh its text while streaming, then settle to "Thought for Ns" on done. */
export function updateReasoningBlock(block: HTMLElement, text: string, done?: boolean, durationMs?: number): void {
  const body = block.querySelector<HTMLElement>('.tm-reasoning-body');
  if (body) { body.innerHTML = ''; body.appendChild(renderMarkdown(text || '')); }
  if (done) { settleReasoningBlock(block, durationMs); return; }
  const label = block.querySelector<HTMLElement>('.tm-reasoning-label');
  block.classList.add('streaming', 'open');
  block.dataset.live = '1';
  block.dataset.streaming = 'true';
  block.querySelector<HTMLElement>('.tm-spin-glyph')?.classList.add('live');
  if (label) label.textContent = 'Thinking';
}

/** Flip a reasoning block to its settled "Thought for Ns" state WITHOUT touching its body —
 *  so a caller that only knows "the run is over" (see the webview's `busy` handler) can stop a
 *  block spinning "Thinking…" without having to re-supply, and re-render, its text. */
export function settleReasoningBlock(block: HTMLElement, durationMs?: number): void {
  if (!block.classList.contains('streaming')) return;
  block.classList.remove('streaming');
  block.dataset.live = '0';
  block.dataset.streaming = 'false';
  block.querySelector<HTMLElement>('.tm-spin-glyph')?.classList.remove('live');
  const label = block.querySelector<HTMLElement>('.tm-reasoning-label');
  if (label) {
    label.textContent = durationMs && durationMs > 0
      ? `Thought for ${fmtDuration(Math.max(1, durationMs / 1000))}`
      : 'Thought';
  }
  // Collapse a beat AFTER the stream ends, the way AI Elements' Reasoning does. Closing on
  // the same tick reads as the text being yanked away mid-sentence; the pause lets the eye
  // finish the last line and register the "Thought for Ns" label. Skipped if the reader
  // opened it themselves in the meantime — `data-user-open` is set by the header click.
  setTimeout(() => {
    if (block.dataset.userOpen !== '1') block.classList.remove('open');
  }, 1000);
}

/**
 * Build a tool card from a step object.
 * Handles both reasoning blocks (delegates to buildReasoningBlock) and regular tool calls.
 * Requires currentMode to determine expansion behavior.
 * Enhanced with AI Elements Tool component patterns.
 */
// ========== Grouped read rows (docs/UI_POLISH_TOOL_REASONING_2026-09-02.md item 1) ==========
// A run of consecutive SAME-TOOL read calls (readFile, readFile, readFile — never a mix of
// different tools under one verb, which would read as grammatically odd: "Read a.ts, 'foo'"
// makes no sense if the second call was actually a grep) collapses into one line: bold verb +
// comma-joined targets, instead of N separate cards. This is the single biggest declutter win
// from the Codex/OpenCode research — a coding agent's most common action by far is reading a
// handful of files before doing anything else.

/** Tools eligible for grouping — genuinely side-effect-free inspection calls only. Anything
 *  that writes, runs a command, or has meaningfully different per-call output (diagnostics,
 *  the repo graph) stays its own card; grouping those would hide information, not noise. */
export const GROUPABLE_TOOL_NAMES = new Set(['readFile', 'grep', 'glob', 'listDir', 'searchWorkspace']);

const GROUP_VERB: Record<string, string> = {
  readFile: 'Read',
  grep: 'Searched',
  searchWorkspace: 'Searched',
  glob: 'Matched',
  listDir: 'Explored',
};

/** The short label for one item inside a grouped row — a path for file-shaped tools, the
 *  query/pattern for search-shaped ones. Mirrors the extraction toolLabel() does per tool,
 *  just without the "Analyzed"/"Searched" verb prefix each call would otherwise carry alone. */
function groupTargetFor(name: string, args: unknown): string {
  const argsObj = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  if (name === 'grep' || name === 'searchWorkspace') {
    const query = String((argsObj as { query?: string; pattern?: string; term?: string }).query
      || (argsObj as { pattern?: string }).pattern || (argsObj as { term?: string }).term || '').trim();
    return query || 'pattern';
  }
  const path = shortPath(String(firstArg(args) || ''));
  return path || (name === 'listDir' ? 'files' : 'a file');
}

export interface ToolGroupItem {
  toolCallId: string;
  name: string;
  args?: unknown;
  state?: 'running' | 'done' | 'error';
  durationMs?: number;
}

/** Build one collapsed row for a run of same-tool reads. Status is aggregated across the
 *  group (spinning while ANY item is still running, a check once ALL settle, an error mark if
 *  ANY did) — matching the "one glyph, two states" rule item 5 already applies to reasoning;
 *  a group showing N independent spinners would be exactly the chrome this is meant to remove.
 *  Duration is the sum of each item's own durationMs, shown once every item has one. */
export function buildToolGroupRow(items: ToolGroupItem[]): HTMLElement {
  const name = items[0]?.name ?? '';
  const verb = GROUP_VERB[name] ?? 'Read';
  const anyRunning = items.some((it) => it.state === 'running' || !it.state);
  const anyError = items.some((it) => it.state === 'error');
  const groupState: 'running' | 'done' | 'error' = anyRunning ? 'running' : anyError ? 'error' : 'done';
  const allDurations = items.every((it) => it.durationMs != null);
  const totalMs = allDurations ? items.reduce((sum, it) => sum + (it.durationMs || 0), 0) : undefined;

  const row = el('div', { class: `tm-tool-group ${groupState}`, dataset: { group: '1' } });
  row.appendChild(buildSpinGlyph(
    groupState === 'running',
    groupState === 'error' ? '✗' : '✓',
    groupState === 'error' ? 'error' : groupState === 'done' ? 'success' : undefined,
  ));

  // Verb + targets share a flex-1 box so a long target list wraps UNDER the verb while the
  // duration stays pinned to the first line. Previously everything was one wrapping row, so a
  // long list pushed "· 0.1s" onto a line of its own, right-aligned under the targets (live
  // repro: "Searched class .* extends Module|nwidart|ModuleServiceProvider").
  const main = el('span', { class: 'tm-tool-group-main' });
  main.appendChild(el('span', { class: 'tm-tool-group-verb' }, verb));

  // One span per DISTINCT target: the agent re-reading the same path twice in a row is real,
  // but "Read routes/api.php, routes/api.php" reads as a rendering fault, not as information.
  // Every call id that resolved to the same target rides on that one span (space-separated,
  // matched with the [data-tc~="id"] selector), so each call is still individually
  // addressable when its own running → done update lands.
  const byTarget = new Map<string, string[]>();
  for (const it of items) {
    const label = groupTargetFor(it.name, it.args);
    const ids = byTarget.get(label);
    if (ids) ids.push(it.toolCallId); else byTarget.set(label, [it.toolCallId]);
  }
  const targets = el('span', { class: 'tm-tool-group-targets' });
  let i = 0;
  for (const [label, ids] of byTarget) {
    if (i++ > 0) targets.appendChild(el('span', { class: 'tm-tool-group-sep' }, ', '));
    targets.appendChild(el('span', {
      class: 'tm-tool-group-target', dataset: { tc: ids.join(' ') },
    }, label));
  }
  main.appendChild(targets);
  row.appendChild(main);

  if (totalMs != null && totalMs > 0 && groupState !== 'running') {
    row.appendChild(el('span', { class: 'tm-tool-group-duration' }, `· ${fmtToolDuration(totalMs)}`));
  }
  return row;
}

export function buildToolCard(step: ToolStep, onRetry?: () => void, onCancel?: () => void): HTMLElement {
  // Reasoning blocks are handled separately
  if (step.name === 'reasoning') {
    const isStreaming = step.state === 'running';
    return buildReasoningBlock(step.detail || '', step.toolCallId, isStreaming);
  }

  const state = step.state || 'done';
  const { title, hint } = toolLabel(step.name, step.args, step.detail, state);

  const card = el('div', {
    class: `tm-tool-card ${state}`,
    dataset: step.toolCallId ? { tc: step.toolCallId } : undefined
  });

  // AI Elements-style header with actions
  card.appendChild(createToolHeader(title, hint || '', state, onRetry, onCancel, step.durationMs));

  const { el: more, pre } = createToolBody();
  card.appendChild(more);

  // Validation result styling
  const isValidationStatic = step.name === 'runCommand' && /\b(tsc|eslint|prettier|lint|typecheck|check|jest|vitest|mocha|pytest|go\s+test|cargo\s+(check|test)|npm\s+test|yarn\s+test|pnpm\s+test)\b/.test(
    String(step.args && typeof step.args === 'object' ? ((step.args as Record<string, unknown>).command ?? JSON.stringify(step.args)) : step.args || '')
  );
  if (isValidationStatic) {
    card.classList.add('validation');
  }

  // Handle edit/operation diffs
  const isEditStatic = step.name === 'editFile' || step.name === 'writeFile' || step.name === 'createFile';
  const editArgsStatic = isEditStatic && step.args && typeof step.args === 'object' ? step.args as Record<string, unknown> : null;

  // A markdown file the card already has the full text of (written, created, or read)
  // gets a rendered Preview/Source view instead of the raw JSON/text dump.
  const mdSource = markdownDocSource(step);

  let hasBody = false;
  // The node new bodies swap in for — createToolBody's <details> when unused as-is.
  let bodyAnchor: HTMLElement = more;
  if (mdSource != null) {
    pre.replaceWith(buildMarkdownDoc(mdSource));
    hasBody = true;
  } else if (isEditStatic && editDiffArgs(step.args)) {
    // Real unified diff via diff2html (inline / collapsed / summary by threshold), replacing
    // the generic "View output" collapse entirely.
    const d = editDiffArgs(step.args)!;
    bodyAnchor = buildEditDiff(d.before, d.after, d.path);
    more.replaceWith(bodyAnchor);
    hasBody = true;
  } else {
    const argStr = (step.args && typeof step.args === 'object') ? JSON.stringify(step.args, null, 2) : String(step.args || '');
    const parts: string[] = [];
    if (argStr && argStr !== '{}') parts.push(argStr);
    if (step.detail) parts.push(step.detail);
    const body = parts.join('\n\n');

    if (body.trim()) {
      pre.className = 'tm-tool-card-output';
      pre.textContent = body;
      hasBody = true;
      // Body stays collapsed by default (compact chip row); click the header to expand.
    }
  }
  // Only reveal the expand chevron when there's a body to show.
  if (hasBody) card.classList.add('has-body');
  // Errors open themselves — matching AI Elements' output-error default (see
  // docs/UI_POLISH_TOOL_REASONING_2026-09-02.md item 7). This only changes the DEFAULT open
  // state, not whether it's a disclosure: the header's toggle handler below still closes it
  // like any other card, so a retried-and-fixed call collapses away same as a success would.
  //
  // An EDIT opens itself for the same reason: it is the one step that changed the user's code,
  // and a diff hidden behind a click is a change they never actually saw. A read's contents can
  // stay collapsed — they didn't alter anything — but "what did it do to my file" should never
  // need a click. buildEditDiff still collapses genuinely huge diffs behind its own summary, so
  // this reveals a preview, not thousands of lines.
  if (hasBody && (state === 'error' || isEditStatic)) card.classList.add('open');

  // Add progress bar for running tools
  if (state === 'running') {
    const progress = el('div', { class: 'tm-tool-card-progress' },
      el('div', { class: 'tm-tool-card-progress-bar' })
    );
    card.insertBefore(progress, bodyAnchor);
  }

  // Add click handler for header toggling
  const header = card.querySelector('.tm-tool-card-header');
  if (header) {
    header.addEventListener('click', () => {
      card.classList.toggle('open');
    });
  }

  return card;
}

/** Mutating tools whose title must NOT say the past-tense verb while `state` is still
 *  'running' — unlike read tools (readFile/grep/…), these can sit in 'running' for an
 *  indefinite, user-controlled time while awaiting approval (see permission.ts's
 *  toolApproval), so "Edited path"/"Deleted path" while nothing has happened yet reads as a
 *  bug (the card claiming the action already completed). Read tools keep the existing
 *  always-past-tense wording — they finish in milliseconds and never wait on a human. */
const PRESENT_TENSE_WHILE_RUNNING: Record<string, string> = {
  writeFile: 'Writing', createFile: 'Creating', editFile: 'Editing', deleteFile: 'Deleting', runCommand: 'Running',
};

/**
 * Generate a human-readable label and icon for a tool call.
 * Returns icon, title, and optional hint text.
 */
export function toolLabel(name: string, args: unknown, detail?: string, state?: 'queued' | 'running' | 'done' | 'error'): ToolLabel {
  // Special case: step progress
  if (name === 'step' && args && typeof args === 'object') {
    const stepArgs = args as { step?: number; of?: number; task?: string };
    return {
      icon: '↳',
      title: `Step ${stepArgs.step}/${stepArgs.of}${stepArgs.task ? ': ' + stepArgs.task : ''}`
    };
  }

  // Special case: remember
  if (name === 'remember') {
    const note = String((args && typeof args === 'object' && (args as { note?: string }).note) || '');
    return {
      icon: '✎',
      title: note ? `Remembered: ${note.replace(/\s+/g, ' ').trim().slice(0, 80)}` : 'Saved a memory note',
    };
  }

  // Special case: thinking
  if (name === 'think') {
    const thought = String((args && typeof args === 'object' && (args as { thought?: string }).thought) || '');
    return {
      icon: '◌',
      title: 'Thought' + (thought ? ': ' + thought.replace(/\s+/g, ' ').trim().slice(0, 80) : '')
    };
  }

  // Special cases: the v3 toolset's coordination + network calls, whose target is a task, a
  // URL or a question rather than a path/query — none of those read well through the generic
  // M-map rows below, and three of them want a state-aware verb ("Delegating" vs "Delegated").
  // These live in toolLabel so the live upsert AND the static replay render identically.
  const argFirst = String(firstArg(args) || '');
  const argsObj = args && typeof args === 'object' ? args : {};
  const path = shortPath(argFirst);
  const query = String((argsObj as { query?: string; pattern?: string; term?: string }).query || (argsObj as { pattern?: string }).pattern || (argsObj as { term?: string }).term || '').trim();

  if (name === 'fetchUrl') {
    const u = shortUrl(String((argsObj as { url?: string }).url || argFirst || ''));
    const live = state === 'running' || state === 'queued';
    return { icon: '⊙', title: u ? `${live ? 'Fetching' : 'Fetched'} ${u}` : live ? 'Fetching a page' : 'Fetched a page' };
  }
  if (name === 'delegateTask') {
    const task = String((argsObj as { task?: string }).task || '').replace(/\s+/g, ' ').trim();
    const excerpt = task.length > 64 ? task.slice(0, 63) + '…' : task;
    const live = state === 'running' || state === 'queued';
    if (live) return { icon: '◎', title: excerpt ? `Delegating: "${excerpt}"` : 'Delegating to a sub-agent' };
    return { icon: '◎', title: excerpt ? `Delegated: "${excerpt}"` : 'Delegated to a sub-agent' };
  }
  if (name === 'askUser') {
    const q = String((argsObj as { question?: string }).question || '').replace(/\s+/g, ' ').trim();
    const excerpt = q.length > 64 ? q.slice(0, 63) + '…' : q;
    const live = state === 'running' || state === 'queued';
    if (live) return { icon: '◎', title: 'Asking…' };
    return { icon: '◎', title: excerpt ? `Asked: "${excerpt}"` : 'Asked the user' };
  }

  // Result summary from tool output
  const lines = detail ? String(detail).split('\n').filter(Boolean) : [];
  const count = lines.length;
  const firstLine = (lines[0] || '').trim().slice(0, 80);
  const results = (unit: string) => count > 0 ? `  · ${count} ${unit}${count !== 1 ? 's' : ''}` : '';

  // grep's output is not one-match-per-line once `context` or `filesOnly` is set: context
  // lines come back as `path-N-text` with `--` between groups, and filesOnly returns bare
  // paths. Count only `path:N:` hit lines (or files, labelled as such) so "· 11 results"
  // does not appear for a single match with context:5. "(no matches)" is zero, not one.
  const grepResults = (): string => {
    if (!count || /^\(no matches\)$/.test(lines[0]?.trim() ?? '')) return '';
    const go = argsObj as { filesOnly?: boolean };
    if (go.filesOnly) {
      const n = lines.filter((l) => !l.startsWith('…[')).length;
      return `  · ${n} file${n !== 1 ? 's' : ''}`;
    }
    const n = lines.filter((l) => /^.+?:\d+:/.test(l)).length;
    return n > 0 ? `  · ${n} result${n !== 1 ? 's' : ''}` : '';
  };

  // Special cases with rich formatting
  if (name === 'readFile') {
    const ao = argsObj as { offset?: number; startLine?: number; start_line?: number; limit?: number; count?: number };
    const offset = ao.offset ?? ao.startLine ?? ao.start_line;
    const limit = ao.limit ?? ao.count;
    let title = path ? `Analyzed ${path}` : 'Analyzed a file';
    if (path && offset != null && limit != null) title += `  #L${offset}–${offset + limit - 1}`;
    else if (path && offset != null) title += `  #L${offset}+`;
    return { icon: '⊞', title, hint: '' };
  }

  // Tool mappings
  const M: Record<string, [string, string]> = {
    readFile: ['⊞', path ? `Analyzed ${path}` : 'Analyzed a file'],
    listDir: ['⊟', `Explored ${path || 'files'}${results('entry')}`],
    repoMap: ['⊕', 'Mapped the repository'],
    searchWorkspace: ['⌕', `Searched "${query}"${results('result')}`],
    glob: ['⊞', `Matched ${query || 'pattern'}${results('match')}`],
    grep: ['⌕', `Searched "${query}"${grepResults()}`],
    webSearch: ['⊙', `Searched the web "${query}"${results('result')}`],
    // fetchUrl / delegateTask / askUser render through the special cases above (URL- and
    // task-shaped targets, state-aware verbs) — not through this map.
    getDiagnostics: ['⊘', 'Checked diagnostics'],
    runCommand: ['▸', argFirst ? `Ran ${argFirst.split(/\s+/).slice(0, 6).join(' ')}` : 'Ran a command'],
    writeFile: ['◈', path ? `Wrote ${path}` : 'Wrote a file'],
    createFile: ['◈', path ? `Created ${path}` : 'Created a file'],
    editFile: ['◈', path ? `Edited ${path}` : 'Edited a file'],
    deleteFile: ['◉', path ? `Deleted ${path}` : 'Deleted a file'],
    impactAnalysis: ['⊕', 'Analyzed impact'],
    buildGraph: ['⊕', 'Built the call graph'],
    getSymbolGraph: ['⊕', 'Indexed symbols'],
    getDependencyTree: ['⊕', 'Mapped dependencies'],
    // todoWrite: the TodoSheet is the rich display; the card stays a quiet count line so the
    // raw todos JSON never dumps as the generic "TodoWrite" fallback it used to hit.
    todoWrite: ['≣', `Updated todos${Array.isArray((argsObj as { todos?: unknown[] }).todos) ? ` (${(argsObj as { todos: unknown[] }).todos.length})` : ''}`],
    // exitPlanMode IS plan mode's exit (the plan card is the real UI) — but the engine still
    // fires a tool event for it, and that used to render as the generic "ExitPlanMode" card.
    exitPlanMode: ['▦', 'Proposed the plan'],
    lspCheck: ['⊘', path ? `Checked ${path}` : 'Checked language diagnostics'],
  };

  if (M[name]) {
    const hint = (name === 'runCommand' || name === 'getDiagnostics') && firstLine ? firstLine : '';
    // Pending approval (or actively running) — say so in the present tense instead of the
    // past-tense title below, which would otherwise claim "Edited/Deleted/Ran…" before the
    // user has even clicked Approve/Reject.
    if ((state === 'running' || state === 'queued') && PRESENT_TENSE_WHILE_RUNNING[name]) {
      const verb = PRESENT_TENSE_WHILE_RUNNING[name];
      const title = name === 'runCommand'
        ? (argFirst ? `${verb} ${argFirst.split(/\s+/).slice(0, 6).join(' ')}` : `${verb} a command`)
        : (path ? `${verb} ${path}` : `${verb} a file`);
      return { icon: M[name][0], title, hint };
    }
    return { icon: M[name][0], title: M[name][1], hint };
  }

  // MCP tools
  if (name && name.indexOf('mcp__') === 0) {
    const parts = name.split('__');
    return {
      icon: '⊛',
      title: `Called ${parts[1] || 'MCP'}${parts[2] ? ' ' + parts.slice(2).join(' ') : ''}`,
      hint: firstLine
    };
  }

  // Fallback
  const cap = name ? (name.charAt(0).toUpperCase() + name.slice(1)) : 'Working';
  return { icon: '◎', title: cap, hint: firstLine };
}

/**
 * Generate a present-tense activity verb for live status display.
 * Used in the rolling "Working…" status line.
 */
export function activityFor(name: string, args: unknown): string {
  const argsObj = args && typeof args === 'object' ? args : {};
  const argFirst = String(firstArg(args) || '');
  const path = shortPath(argFirst);
  const query = String((argsObj as { query?: string; pattern?: string; term?: string }).query || (argsObj as { pattern?: string }).pattern || (argsObj as { term?: string }).term || '').trim();
  const cmd = String((argsObj as { command?: string; cmd?: string }).command || (argsObj as { cmd?: string }).cmd || '').trim();

  switch (name) {
    case 'readFile': return path ? `Reading ${path}` : 'Reading a file';
    case 'listDir': return path ? `Listing ${path}` : 'Listing files';
    case 'searchWorkspace':
    case 'grep': return query ? `Searching "${query}"` : 'Searching';
    case 'glob': return query ? `Globbing ${query}` : 'Globbing files';
    case 'runCommand': {
      const c = cmd.split(/\s+/).slice(0, 5).join(' ');
      return c ? `Running ${c}` : 'Running a command';
    }
    case 'writeFile':
    case 'createFile': return path ? `Writing ${path}` : 'Writing a file';
    case 'editFile': return path ? `Editing ${path}` : 'Editing';
    case 'deleteFile': return path ? `Deleting ${path}` : 'Deleting';
    case 'webSearch': return query ? `Searching the web for "${query}"` : 'Searching the web';
    case 'fetchUrl': return argFirst ? `Fetching ${shortUrl(String((argsObj as { url?: string }).url || argFirst))}` : 'Fetching a page';
    case 'delegateTask': {
      const task = String((argsObj as { task?: string }).task || '').replace(/\s+/g, ' ').trim();
      return task ? `Delegating: "${task.slice(0, 64)}${task.length > 64 ? '…' : ''}"` : 'Delegating to a sub-agent';
    }
    case 'askUser': return 'Asking the user';
    case 'todoWrite': return 'Updating todos';
    case 'exitPlanMode': return 'Presenting the plan';
    case 'getDiagnostics': return 'Checking diagnostics';
    case 'repoMap': return 'Mapping the repository';
    case 'lspCheck': return path ? `Checking ${path}` : 'Checking language diagnostics';
    default:
      if (name && name.indexOf('mcp__') === 0) return `Calling ${name.split('__')[1] || 'MCP tool'}`;
      return name ? (name.charAt(0).toUpperCase() + name.slice(1) + '…') : 'Working.';
  }
}

// ========== Private Helpers ==========

/**
 * Extract the first meaningful argument from a tool call args object.
 * Handles various argument shapes (path, file, query, command, etc.).
 */
function firstArg(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const argsObj = a as Record<string, unknown>;
  return String(argsObj.path || argsObj.file || argsObj.filePath || argsObj.filename || argsObj.relativePath || argsObj.url || argsObj.query || argsObj.pattern || argsObj.dir || argsObj.directory || argsObj.term || argsObj.command || '');
}

/**
 * Shorten a file path to the last 2 segments for cleaner display.
 * Handles both Unix and Windows paths.
 */
function shortPath(p: string): string {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
}

/**
 * Shorten a URL for a tool-row title: protocol and www stripped, hard cap at ~48 chars so a
 * long article path can't push the row's "· 0.4s" off the line. The domain stays intact —
 * unlike shortPath()'s last-2-segments rule, "…/somepage" without its host says nothing.
 */
function shortUrl(u: string): string {
  const s = String(u || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '');
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

/**
 * The full markdown text a tool card can preview, or null when there is none.
 * Only tools that carry a whole document qualify: writeFile/createFile hold it in
 * `content`, and a single-path readFile returns it as the tool output. editFile is
 * deliberately excluded — its old_string/new_string pair is a fragment, and the
 * existing inline diff is the more useful view of it.
 */
function markdownDocSource(step: ToolStep): string | null {
  const args = step.args && typeof step.args === 'object' ? step.args as Record<string, unknown> : null;
  if (!args) return null;
  const path = String(args.path ?? args.file ?? args.filePath ?? args.relativePath ?? '');
  if (!MARKDOWN_EXT.test(path)) return null;

  if (step.name === 'writeFile' || step.name === 'createFile') {
    return typeof args.content === 'string' && args.content.trim() ? args.content : null;
  }
  if (step.name === 'readFile') {
    // A failed read returns a message, not a document — keep the plain output for that.
    const detail = typeof step.detail === 'string' ? step.detail : '';
    if (!detail.trim() || /^File not found:/.test(detail)) return null;
    return detail;
  }
  return null;
}

/**
 * Rendered markdown with a Preview/Source switch, for the body of a tool card that
 * wrote or read a `.md` file. Preview is the default view — the point of the card is
 * to show what the document looks like; Source is one click away for the exact bytes.
 */
function buildMarkdownDoc(md: string): HTMLElement {
  const root = el('div', { class: 'tm-md-doc' });

  const preview = el('div', { class: 'tm-md-doc-preview' }, renderMarkdown(md));
  const source = el('pre', { class: 'tm-tool-card-output tm-md-doc-source' });
  source.textContent = md;

  const tab = (label: string, showSource: boolean) => {
    const b = el('button', {
      class: `tm-md-doc-tab${showSource ? '' : ' active'}`,
      type: 'button',
      onClick: (e: Event) => {
        // The card header owns expand/collapse; a tab click must not bubble into it.
        e.stopPropagation();
        root.classList.toggle('show-source', showSource);
        root.querySelectorAll('.tm-md-doc-tab').forEach((t, i) => t.classList.toggle('active', (i === 1) === showSource));
      },
    }, label);
    return b;
  };

  root.appendChild(el('div', { class: 'tm-md-doc-bar' }, tab('Preview', false), tab('Source', true)));
  root.appendChild(preview);
  root.appendChild(source);
  return root;
}

// ── Edit diffs: unified diff → diff2html, gated by the named thresholds above ──────────

function countChangedLines(diff: string): number {
  let n = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue; // file headers
    if (line.startsWith('+') || line.startsWith('-')) n++;
  }
  return n;
}

/** Render a unified-diff string through the vendor diff2html global. Returns null when the
 *  vendor isn't loaded (lazy script) or rejects — callers fall back to a plain <pre>. Same
 *  sink markdown.ts uses for ```diff fences. */
function renderDiff2Html(diffText: string): HTMLElement | null {
  const d2h = window.Diff2Html;
  if (!d2h) return null;
  try {
    const html = d2h.html(diffText, { drawFileList: false, matching: 'lines', outputFormat: 'line-by-line' });
    if (!html || !html.trim()) return null;
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-wrapper';
    wrapper.innerHTML = html;
    return wrapper;
  } catch {
    return null;
  }
}

/** Build the body for an edit tool card from before/after text. ToolCard consumes UNIFIED-DIFF
 *  STRINGS only (via unifiedDiff) — never ad-hoc −/+ fragments. Rendering tier by the plan's
 *  named constants: ≤ both inline caps → expanded rich diff; over an inline cap but under the
 *  preview ceiling → same rich diff collapsed behind a "View diff" disclosure; at/over the
 *  ceiling → summary note only. */
/**
 * The before/after pair out of an edit tool's arguments, in whichever shape they arrived.
 *
 * v3's `editFile` takes `search`/`replace` — or an `edits: [{search, replace}, …]` array for
 * several hunks in one file — while older/MCP-style edit tools use `old_string`/`new_string`.
 * The card only ever looked for the latter, so every real edit fell through to dumping the raw
 * arguments as JSON instead of rendering a diff (live repro: an `editFile` card showing
 * `{"path": …, "search": …, "replace": …}` under "View output").
 *
 * Multiple hunks are joined into one before/after pair so they read as a single diff of the
 * file, which is what actually happened — they are applied atomically in one read/write.
 * Returns null when the arguments carry no usable pair.
 */
export function editDiffArgs(args: unknown): { before: string; after: string; path?: string } | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const path = typeof a.path === 'string' ? a.path : undefined;

  if (Array.isArray(a.edits) && a.edits.length > 0) {
    const hunks = a.edits.filter((h): h is Record<string, unknown> => !!h && typeof h === 'object');
    if (hunks.length === 0) return null;
    return {
      before: hunks.map((h) => String(h.search ?? '')).join('\n'),
      after: hunks.map((h) => String(h.replace ?? '')).join('\n'),
      path,
    };
  }
  if (typeof a.search === 'string') return { before: a.search, after: String(a.replace ?? ''), path };
  if (a.old_string != null && a.new_string != null) {
    return { before: String(a.old_string), after: String(a.new_string), path };
  }
  return null;
}

export function buildEditDiff(oldStr: string, newStr: string, path?: string): HTMLElement {
  const box = el('div', { class: 'tm-edit-diff' });
  const oldText = String(oldStr ?? '');
  const newText = String(newStr ?? '');
  const labels = path ? { oldLabel: `a/${path}`, newLabel: `b/${path}` } : {};
  const diff = unifiedDiff(oldText, newText, labels);

  if (!diff.trim()) {
    // No textual difference after normalization (e.g. a CRLF↔LF-only rewrite).
    box.append(el('div', { class: 'tm-diff-summary' }, 'No content change (line endings only).'));
    return box;
  }

  const changed = countChangedLines(diff);
  const bytes = new TextEncoder().encode(diff).length;

  // Over the preview ceiling: no full diff at all.
  if (changed >= DIFF_PREVIEW_MAX_CHANGED_LINES) {
    box.append(el('div', { class: 'tm-diff-summary' },
      `${changed.toLocaleString()} changed lines — too large to render here. The saved file has the full content.`));
    return box;
  }

  let view = renderDiff2Html(diff);
  if (!view) {
    // Vendor not loaded / rejected — plain unified text keeps the info visible either way.
    const pre = el('pre', { class: 'tm-tool-card-output diff-view' });
    pre.textContent = diff;
    view = pre;
  }

  if (changed >= INLINE_DIFF_MAX_CHANGED_LINES || bytes > INLINE_DIFF_MAX_BYTES) {
    const det = el('details', { class: 'tm-edit-diff-collapsed' },
      el('summary', null, `View diff · ${changed.toLocaleString()} changed line${changed === 1 ? '' : 's'}`),
      view,
    );
    box.append(det);
  } else {
    box.append(view);
  }
  return box;
}

// ========== Types ==========

export interface ToolStep {
  name: string;
  args?: unknown;
  detail?: string;
  state?: 'running' | 'done' | 'error';
  toolCallId?: string;
  /** How long the call took to settle, in ms — rendered as `· {duration}` next to the status
   *  label (docs/UI_POLISH_TOOL_REASONING_2026-09-02.md item 3). Absent while running. */
  durationMs?: number;
}

export interface ToolLabel {
  icon: string;
  title: string;
  hint?: string;
}

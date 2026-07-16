/* Tool card and status rendering utilities. */

import { renderMarkdown } from './markdown';

// ========== Constants ==========

const STATE_ICON = { running: null, done: '✓', error: '✗' } as const;
type StateIcon = typeof STATE_ICON;

// ========== Public API ==========

/**
 * Build a reasoning/thinking block for display in the tool flow.
 * Used for both live "Thinking" blocks and static "Thought" cards.
 */
export function buildReasoningBlock(text: string, tc?: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'think-block';
  block.dataset.live = '1';
  if (tc) block.dataset.tc = tc;

  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.innerHTML = `<span class="think-ic">◌</span><span class="think-cap">Thinking</span>`;

  const body = document.createElement('div');
  body.className = 'think-body';
  body.appendChild(renderMarkdown(text || ''));

  det.appendChild(sum);
  det.appendChild(body);
  block.appendChild(det);

  return block;
}

/**
 * Build a tool card from a step object.
 * Handles both reasoning blocks (delegates to buildReasoningBlock) and regular tool calls.
 * Requires currentMode to determine expansion behavior.
 */
export function buildToolCard(step: ToolStep): HTMLElement {
  // Reasoning blocks are handled separately
  if (step.name === 'reasoning') {
    const block = buildReasoningBlock(step.detail || '', step.toolCallId);
    // Static re-render: reasoning is done, show as collapsed "Thought"
    block.dataset.live = '0';
    const cap = block.querySelector('.think-cap');
    if (cap) cap.textContent = 'Thought';
    const ic = block.querySelector('.think-ic');
    if (ic) ic.textContent = '◉';
    return block;
  }

  const state = step.state || 'done';
  const card = document.createElement('div');
  card.className = 'tool-card state-' + state;
  if (step.toolCallId) card.dataset.tc = step.toolCallId;

  card.innerHTML = `<div class="tool-head"><span class="tool-ic"></span><span class="tool-title"></span><span class="tool-hint"></span><span class="state"></span></div><details class="tool-more hidden"><summary>output</summary><pre></pre></details>`;

  const { icon, title, hint } = toolLabel(step.name, step.args, step.detail);
  const toolIcon = card.querySelector('.tool-ic');
  if (toolIcon) toolIcon.textContent = icon;

  const toolTitle = card.querySelector('.tool-title');
  if (toolTitle) toolTitle.textContent = title;

  const hintEl = card.querySelector('.tool-hint');
  if (hintEl) hintEl.textContent = hint || '';

  const st = card.querySelector('.state');
  if (st) {
    st.className = 'state ' + state;
    const icon2 = STATE_ICON[state];
    st.textContent = (icon2 === null || icon2 === undefined) ? '' : icon2;
  }

  // Validation result styling
  const isValidationStatic = step.name === 'runCommand' && /\b(tsc|eslint|prettier|lint|typecheck|check|jest|vitest|mocha|pytest|go\s+test|cargo\s+(check|test)|npm\s+test|yarn\s+test|pnpm\s+test)\b/.test(
    String(step.args && typeof step.args === 'object' ? ((step.args as Record<string, unknown>).command ?? JSON.stringify(step.args)) : step.args || '')
  );
  if (isValidationStatic) {
    card.className += ' validation';
  }

  const more = card.querySelector('.tool-more') as HTMLElement;
  const pre = more?.querySelector('pre') as HTMLElement;

  if (!pre || !more) return card;

  // Handle edit/operation diffs
  const isEditStatic = step.name === 'editFile' || step.name === 'writeFile' || step.name === 'createFile';
  const editArgsStatic = isEditStatic && step.args && typeof step.args === 'object' ? step.args as Record<string, unknown> : null;

  if (editArgsStatic && 'old_string' in editArgsStatic && 'new_string' in editArgsStatic) {
    pre.className = 'diff-view';
    pre.appendChild(buildInlineDiff(String(editArgsStatic.old_string), String(editArgsStatic.new_string)));
    (more as HTMLDetailsElement).open = true;
  } else {
    const argStr = (step.args && typeof step.args === 'object') ? JSON.stringify(step.args, null, 2) : String(step.args || '');
    const parts: string[] = [];
    if (argStr && argStr !== '{}') parts.push(argStr);
    if (step.detail) parts.push(step.detail);
    const body = parts.join('\n\n');

    if (body.trim()) {
      pre.textContent = body;
      more.classList.remove('hidden');
      (more as HTMLDetailsElement).open = true;
    }
  }

  return card;
}

/**
 * Generate a human-readable label and icon for a tool call.
 * Returns icon, title, and optional hint text.
 */
export function toolLabel(name: string, args: unknown, detail?: string): ToolLabel {
  // Special case: step progress
  if (name === 'step' && args && typeof args === 'object') {
    const stepArgs = args as { step?: number; of?: number; task?: string };
    return {
      icon: '↳',
      title: `Step ${stepArgs.step}/${stepArgs.of}${stepArgs.task ? ': ' + stepArgs.task : ''}`
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

  const argFirst = String(firstArg(args) || '');
  const argsObj = args && typeof args === 'object' ? args : {};
  const path = shortPath(argFirst);
  const query = String((argsObj as { query?: string; pattern?: string; term?: string }).query || (argsObj as { pattern?: string }).pattern || (argsObj as { term?: string }).term || '').trim();

  // Result summary from tool output
  const lines = detail ? String(detail).split('\n').filter(Boolean) : [];
  const count = lines.length;
  const firstLine = (lines[0] || '').trim().slice(0, 80);
  const results = (unit: string) => count > 0 ? `  · ${count} ${unit}${count !== 1 ? 's' : ''}` : '';

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
    grep: ['⌕', `Searched "${query}"${results('result')}`],
    webSearch: ['⊙', `Searched the web "${query}"${results('result')}`],
    webFetch: ['⊙', argFirst ? `Fetched ${shortPath(argFirst)}` : 'Fetched a URL'],
    getDiagnostics: ['⊘', 'Checked diagnostics'],
    runCommand: ['▸', argFirst ? `Ran ${argFirst.split(/\s+/).slice(0, 6).join(' ')}` : 'Ran a command'],
    writeFile: ['◈', path ? `Wrote ${path}` : 'Wrote a file'],
    createFile: ['◈', path ? `Created ${path}` : 'Created a file'],
    editFile: ['◈', path ? `Edited ${path}` : 'Edited a file'],
    deleteFile: ['◉', path ? `Deleted ${path}` : 'Deleted a file'],
    impactAnalysis: ['⊕', 'Analyzed impact'],
    buildGraph: ['⊕', 'Built the call graph'],
    getSymbolGraph: ['⊕', 'Indexed symbols'],
    askUser: ['◎', 'Asking…'],
    skill: ['◎', argFirst ? `Delegated to ${shortPath(argFirst)}` : 'Delegated to a sub-agent'],
    lspCheck: ['⊘', path ? `Checked ${path}` : 'Checked language diagnostics'],
  };

  if (M[name]) {
    const hint = (name === 'runCommand' || name === 'getDiagnostics') && firstLine ? firstLine : '';
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
    case 'webFetch': return argFirst ? `Fetching ${shortPath(argFirst)}` : 'Fetching';
    case 'getDiagnostics': return 'Checking diagnostics';
    case 'repoMap': return 'Mapping the repository';
    case 'skill': return argFirst ? `Delegating to ${shortPath(argFirst)}` : 'Delegating to a sub-agent';
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
  return String(argsObj.path || argsObj.file || argsObj.filePath || argsObj.filename || argsObj.relativePath || argsObj.query || argsObj.pattern || argsObj.dir || argsObj.directory || argsObj.term || argsObj.command || '');
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
 * Build a simple before/after diff fragment for inline edit display.
 * Returns a DocumentFragment with styled diff lines.
 */
function buildInlineDiff(oldStr: string, newStr: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  String(oldStr).split('\n').forEach((l) => {
    const row = document.createElement('div');
    row.className = 'diff-del';
    row.textContent = '− ' + l;
    frag.appendChild(row);
  });
  String(newStr).split('\n').forEach((l) => {
    const row = document.createElement('div');
    row.className = 'diff-add';
    row.textContent = '+ ' + l;
    frag.appendChild(row);
  });
  return frag;
}

// ========== Types ==========

export interface ToolStep {
  name: string;
  args?: unknown;
  detail?: string;
  state?: 'running' | 'done' | 'error';
  toolCallId?: string;
}

export interface ToolLabel {
  icon: string;
  title: string;
  hint?: string;
}

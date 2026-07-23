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
import { el } from '../dom';
import { createCollapse } from '../primitives/Collapse';

// ========== Constants ==========

const STATE_ICON = { running: null, done: '✓', error: '✗' } as const;
const STATE_LABEL = { 
  running: 'Running', 
  done: 'Completed', 
  error: 'Error',
  pending: 'Pending'
} as const;
type StateIcon = typeof STATE_ICON;
type StateLabel = typeof STATE_LABEL;

// ========== Structure ==========

/** The `.tm-tool-card-header` row: icon + title + hint + state indicator + actions.
 *  Enhanced with AI Elements patterns for better visual hierarchy and UX. */
function createToolHeader(icon: string, title: string, hint: string, state: 'running' | 'done' | 'error' | 'pending', onRetry?: () => void, onCancel?: () => void): HTMLElement {
  const stateIcon = STATE_ICON[state];
  const stateLabel = STATE_LABEL[state];
  
  return el('div', { class: 'tm-tool-card-header' },
    el('div', { class: 'tm-tool-card-info' },
      el('span', { class: 'tm-tool-card-icon' }, icon),
      el('span', { class: 'tm-tool-card-title' }, title),
      hint ? el('span', { class: 'tm-tool-card-hint' }, hint) : null
    ),
    el('div', { class: 'tm-tool-card-status' },
      el('div', { class: `tm-tool-card-state ${state}` }, stateIcon || ''),
      el('span', { class: 'tm-tool-card-state-label' }, stateLabel)
    ),
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
export function buildReasoningBlock(text: string, tc?: string, isStreaming?: boolean): HTMLElement {
  const block = el('div', { 
    class: `tm-reasoning ${isStreaming ? 'streaming' : ''}`, 
    dataset: { live: isStreaming ? '1' : '0', ...(tc ? { tc } : {}) } 
  });

  // AI Elements-style header with icon and streaming indicator
  const header = el('div', { class: 'tm-reasoning-header' },
    el('div', { class: 'tm-reasoning-title' },
      el('span', { class: 'tm-reasoning-icon' }, isStreaming ? '◌' : '◉'),
      isStreaming ? 'Thinking' : 'Thought'
    ),
    isStreaming ? el('div', { class: 'tm-reasoning-streaming' },
      el('span', { class: 'tm-reasoning-streaming-dots' },
        el('span'),
        el('span'),
        el('span')
      ),
      'Thinking'
    ) : el('div', { class: 'tm-reasoning-duration' }, 'Completed')
  );
  
  block.appendChild(header);

  // Collapsible content area
  const content = el('div', { class: 'tm-reasoning-content' });
  const body = el('div', { class: 'tm-reasoning-body tm-reasoning-text' }, renderMarkdown(text || ''));
  
  content.appendChild(body);
  block.appendChild(content);

  // Add click handler for toggling
  header.addEventListener('click', () => {
    block.classList.toggle('open');
  });

  // Auto-expand when streaming
  if (isStreaming) {
    block.classList.add('open');
  }

  return block;
}

/**
 * Build a tool card from a step object.
 * Handles both reasoning blocks (delegates to buildReasoningBlock) and regular tool calls.
 * Requires currentMode to determine expansion behavior.
 * Enhanced with AI Elements Tool component patterns.
 */
export function buildToolCard(step: ToolStep, onRetry?: () => void, onCancel?: () => void): HTMLElement {
  // Reasoning blocks are handled separately
  if (step.name === 'reasoning') {
    const isStreaming = step.state === 'running';
    return buildReasoningBlock(step.detail || '', step.toolCallId, isStreaming);
  }

  const state = step.state || 'done';
  const { icon, title, hint } = toolLabel(step.name, step.args, step.detail);

  const card = el('div', { 
    class: `tm-tool-card ${state}`, 
    dataset: step.toolCallId ? { tc: step.toolCallId } : undefined 
  });
  
  // AI Elements-style header with actions
  card.appendChild(createToolHeader(icon, title, hint || '', state, onRetry, onCancel));

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

  if (editArgsStatic && 'old_string' in editArgsStatic && 'new_string' in editArgsStatic) {
    pre.className = 'tm-tool-card-output diff-view';
    pre.appendChild(buildInlineDiff(String(editArgsStatic.old_string), String(editArgsStatic.new_string)));
    more.classList.remove('hidden');
    card.classList.add('open');
    more.open = true;
  } else {
    const argStr = (step.args && typeof step.args === 'object') ? JSON.stringify(step.args, null, 2) : String(step.args || '');
    const parts: string[] = [];
    if (argStr && argStr !== '{}') parts.push(argStr);
    if (step.detail) parts.push(step.detail);
    const body = parts.join('\n\n');

    if (body.trim()) {
      pre.className = 'tm-tool-card-output';
      pre.textContent = body;
      more.classList.remove('hidden');
      card.classList.add('open');
      more.open = true;
    }
  }

  // Add progress bar for running tools
  if (state === 'running') {
    const progress = el('div', { class: 'tm-tool-card-progress' },
      el('div', { class: 'tm-tool-card-progress-bar' })
    );
    card.insertBefore(progress, more);
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

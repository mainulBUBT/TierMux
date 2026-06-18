// Persistent behavioral memory: a workspace file (.tiermux/memory.md) holding the user's
// style, tone, and standing instructions, plus a free-heuristic auto-learned section.
// Loaded every (non-trivial) turn and injected into the system prompt so weak models get
// consistent reinforcement instead of re-guessing. Mirrors projectRules.ts (file read) and
// modelStats.ts (no backend, local only).
import * as vscode from 'vscode';
import type { ChatMessage } from '../shared/types';

const MEMORY_REL = '.tiermux/memory.md';
const DIR_REL = '.tiermux';
const MAX_CHARS = 1500;
const SECTION_START = '<!-- auto-learned by TierMux (safe to edit or delete) -->';
const SECTION_END = '<!-- end auto-learned -->';

const HEADER = `# TierMux memory — your style, tone & standing instructions

The agent reads this file every turn and follows it exactly. Edit freely — what you write
here always takes priority over its defaults. Keep it short: it's injected into every request.

`;

function rootUri(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}
function dirUri(): vscode.Uri | undefined {
  const root = rootUri();
  return root ? vscode.Uri.joinPath(root, DIR_REL) : undefined;
}
function memoryUri(): vscode.Uri | undefined {
  const root = rootUri();
  return root ? vscode.Uri.joinPath(root, MEMORY_REL) : undefined;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** Load the memory file for injection (capped). Returns '' if absent. */
export async function loadUserMemory(): Promise<string> {
  const uri = memoryUri();
  if (!uri) return '';
  const text = await readText(uri);
  if (!text) return '';
  return text.trim().slice(0, MAX_CHARS);
}

/**
 * Cheap, model-free style inference from the files the agent wrote/edited in a transcript.
 * Looks at writeFile/createFile content and editFile replacements for indentation, quote
 * style, and semicolons. Returns a short bulleted block (or '' if nothing confident).
 */
export function inferStyleFromEdits(work: ChatMessage[]): string {
  const samples: string[] = [];
  for (const m of work) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      const fn = call.function?.name;
      if (fn !== 'writeFile' && fn !== 'createFile' && fn !== 'editFile') continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { continue; }
      const text = fn === 'editFile' ? String(args.replace ?? '') : String(args.content ?? '');
      if (text) samples.push(text);
    }
  }
  if (!samples.length) return '';

  const lines = samples.join('\n').split('\n').filter((l) => l.length > 0);

  // Indentation: tab vs the smallest leading-space run among indented lines.
  let tabs = 0;
  const spaceRuns: number[] = [];
  for (const l of lines) {
    if (!/^\s/.test(l) || !l.trim()) continue;
    if (/^\t/.test(l)) tabs++;
    else { const m = l.match(/^ +/); if (m) spaceRuns.push(m[0].length); }
  }
  let indent = '';
  const minSpace = spaceRuns.length ? Math.min(...spaceRuns) : 0;
  if (tabs >= 2 && tabs >= spaceRuns.length) indent = 'tabs';
  else if (minSpace >= 2) indent = minSpace % 4 === 0 ? '4 spaces' : '2 spaces';

  // String quotes: leading-delimiter counts (rough but fine for a heuristic).
  const singles = (samples.join('\n').match(/(^|[=\s(:,[{])'/g) ?? []).length;
  const doubles = (samples.join('\n').match(/(^|[=\s(:,[{])"/g) ?? []).length;
  const quotes = singles > doubles ? 'single' : doubles > singles ? 'double' : '';

  // Semicolons (JS/TS-style line endings).
  const semis = lines.filter((l) => /;\s*(\/\/.*)?$/.test(l)).length;
  const semisYes = semis >= 3;
  const semisNo = lines.length >= 6 && semis === 0;

  const out: string[] = [];
  if (indent) out.push(`- Indentation: ${indent}`);
  if (quotes) out.push(`- String quotes: ${quotes}`);
  if (semisYes) out.push('- Semicolons: yes');
  else if (semisNo) out.push('- Semicolons: no');
  return out.join('\n');
}

/** Idempotently write the auto-learned style section into .tiermux/memory.md. */
export async function upsertLearnedSection(rules: string): Promise<void> {
  const uri = memoryUri();
  const dir = dirUri();
  if (!uri || !dir || !rules.trim()) return;
  const block = `${SECTION_START}\n${rules.trim()}\n${SECTION_END}`;
  const existing = await readText(uri);
  let next: string;
  if (existing == null) {
    next = `${HEADER}${block}\n`;
  } else if (existing.includes(SECTION_START) && existing.includes(SECTION_END)) {
    const re = new RegExp(`${escapeReg(SECTION_START)}[\\s\\S]*?${escapeReg(SECTION_END)}`);
    next = re.test(existing) ? existing.replace(re, block) : `${existing.trimEnd()}\n\n${block}\n`;
  } else {
    next = `${existing.trimEnd()}\n\n${block}\n`;
  }
  if (next === existing) return;
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
  } catch { /* best-effort: memory is non-critical */ }
}

/** Ensure the memory file exists (with a template header) and open it for editing. */
export async function openMemoryForEdit(): Promise<void> {
  const uri = memoryUri();
  const dir = dirUri();
  if (!uri || !dir) { void vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
  if ((await readText(uri)) == null) {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(HEADER));
  }
  await vscode.commands.executeCommand('vscode.open', uri);
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

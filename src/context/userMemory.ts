

import * as vscode from 'vscode';

const MEMORY_REL = '.tiermux/memory.md';
const DIR_REL = '.tiermux';
/** Injection caps: the user's own text, then the learned section — trimmed separately so a
 *  growing learned list can never push the user's standing instructions out of the prompt. */
const MAX_USER_CHARS = 1500;
const MAX_LEARNED_CHARS = 1200;
/** Newest entries kept in the learned section on disk. */
const MAX_LEARNED_ENTRIES = 20;

/** Agent-maintained section: what the user corrected or rejected, lifted from each
 *  compaction's "Corrections & rejected approaches" (see condense.ts). Zero extra model calls —
 *  the summary already had to write it. */
const LEARNED_HEADING = '## Learned from corrections (agent-maintained)';

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

/** Tail-cap on a line boundary (most recent content wins). */
function tailCap(text: string, max: number): string {
  if (text.length <= max) return text;
  const rawTail = text.slice(-max);
  const lineBreakIndex = rawTail.indexOf('\n');
  return lineBreakIndex !== -1 ? rawTail.slice(lineBreakIndex + 1) : rawTail;
}

function splitLearned(text: string): { user: string; learned: string[] } {
  const at = text.indexOf(LEARNED_HEADING);
  if (at === -1) return { user: text.trim(), learned: [] };
  const learned = text.slice(at + LEARNED_HEADING.length).split('\n')
    .map((l) => l.trim().replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
  return { user: text.slice(0, at).trim(), learned };
}

function joinLearned(user: string, learned: string[]): string {
  if (!learned.length) return `${user.trimEnd()}\n`;
  return `${user.trimEnd()}\n\n${LEARNED_HEADING}\n${learned.map((e) => `- ${e}`).join('\n')}\n`;
}

/** Load the memory file for injection. Returns '' if absent. */
export async function loadUserMemory(): Promise<string> {
  const uri = memoryUri();
  if (!uri) return '';
  const text = (await readText(uri))?.trim();
  if (!text) return '';
  const { user, learned } = splitLearned(text);
  const learnedBlock = learned.length ? tailCap(`${LEARNED_HEADING}\n${learned.map((e) => `- ${e}`).join('\n')}`, MAX_LEARNED_CHARS) : '';
  return [tailCap(user, MAX_USER_CHARS), learnedBlock].filter(Boolean).join('\n\n');
}

/** Normalized form for de-duplication: case, punctuation and whitespace folded. */
function normalize(entry: string): string {
  return entry.toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]+/g, ' ').trim();
}

/** Append corrections to the learned section (creating the file if needed): de-duplicated,
 *  newest last, capped at MAX_LEARNED_ENTRIES. Returns how many were actually added. */
export async function appendLearned(entries: string[]): Promise<number> {
  const uri = memoryUri();
  const dir = dirUri();
  if (!uri || !dir) return 0;
  const clean = entries.map((e) => e.replace(/\s+/g, ' ').trim()).filter((e) => e.length >= 8 && e.length <= 300);
  if (!clean.length) return 0;
  const existing = await readText(uri);
  const { user, learned } = splitLearned(existing ?? HEADER);
  const seen = new Set(learned.map(normalize));
  const added: string[] = [];
  for (const e of clean) {
    const n = normalize(e);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    added.push(e);
  }
  if (!added.length) return 0;
  const merged = [...learned, ...added].slice(-MAX_LEARNED_ENTRIES);
  if (existing == null) await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(joinLearned(user || HEADER.trim(), merged)));
  return added.length;
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

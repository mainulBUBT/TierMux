

import * as vscode from 'vscode';

const MEMORY_REL = '.tiermux/memory.md';
const DIR_REL = '.tiermux';
const MAX_CHARS = 1500;

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

/** Load the memory file for injection (capped, most-recent content wins). Returns '' if absent. */
export async function loadUserMemory(): Promise<string> {
  const uri = memoryUri();
  if (!uri) return '';
  const text = (await readText(uri))?.trim();
  if (!text) return '';
  if (text.length <= MAX_CHARS) return text;
  const rawTail = text.slice(-MAX_CHARS);
  const lineBreakIndex = rawTail.indexOf('\n');
  return lineBreakIndex !== -1 ? rawTail.slice(lineBreakIndex + 1) : rawTail;
}

function normalizeLine(s: string): string {
  return s.replace(/^[-*]\s*/, '').trim().toLowerCase();
}

let writeQueue: Promise<void> = Promise.resolve();

/**
 * Append a note to the memory file, for the agent's own `remember` tool.
 * Serialized (parallel tool calls in one turn must not race the same read/write cycle),
 * deduped by whole-line comparison (not substring, to avoid false positives like
 * "use tabs" matching inside "never use tabs"), and returns whether it actually wrote.
 */
export function appendUserMemory(note: string): Promise<boolean> {
  const sanitized = note.replace(/[\r\n]+/g, ' ').trim();
  const result = writeQueue.then(async (): Promise<boolean> => {
    const uri = memoryUri();
    const dir = dirUri();
    if (!uri || !dir || !sanitized) return false;
    const existing = (await readText(uri)) ?? '';
    const target = normalizeLine(sanitized);
    if (existing.split('\n').some((line) => normalizeLine(line) === target)) return false;
    await vscode.workspace.fs.createDirectory(dir);
    const next = `${existing.trimEnd()}\n- ${sanitized}\n`.trimStart();
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
    return true;
  });
  writeQueue = result.then(
    () => undefined,
    () => undefined, // don't let a rejected write poison the queue for later calls
  );
  return result;
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

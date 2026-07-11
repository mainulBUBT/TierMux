

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

/** Load the memory file for injection (capped). Returns '' if absent. */
export async function loadUserMemory(): Promise<string> {
  const uri = memoryUri();
  if (!uri) return '';
  const text = await readText(uri);
  if (!text) return '';
  return text.trim().slice(0, MAX_CHARS);
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

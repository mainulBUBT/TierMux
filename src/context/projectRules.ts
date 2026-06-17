// Loads project convention files (AGENTS.md, CLAUDE.md, .cursorrules, etc.) so
// the agent follows the repo's rules every turn.
import * as vscode from 'vscode';

const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md'];
const MAX_CHARS = 8000;

export async function loadProjectRules(): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return '';
  const parts: string[] = [];
  for (const f of RULE_FILES) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, f))).trim();
      if (text) parts.push(`## ${f}\n${text}`);
    } catch { /* not present */ }
    if (parts.join('\n\n').length > MAX_CHARS) break;
  }
  return parts.join('\n\n').slice(0, MAX_CHARS);
}

// Ambient editor context: the active file (a slice around the cursor) and open
// tab names, so the agent knows what you're looking at without an @-mention.
import * as vscode from 'vscode';

const SLICE_RADIUS = 25;
const MAX_SLICE_CHARS = 3000;

export function buildAmbientContext(): string {
  if (!vscode.workspace.getConfiguration('tiermux.context').get<boolean>('includeOpenEditors', true)) return '';
  const lines: string[] = [];

  try {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : null))
      .filter((x): x is string => !!x);
    const uniq = [...new Set(tabs)].slice(0, 12);
    if (uniq.length) lines.push('Open tabs: ' + uniq.join(', '));
  } catch { /* ignore */ }

  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') {
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const cur = ed.selection.active.line;
    const start = Math.max(0, cur - SLICE_RADIUS);
    const end = Math.min(ed.document.lineCount, cur + SLICE_RADIUS + 1);
    const slice = ed.document.getText(new vscode.Range(start, 0, end, 0)).slice(0, MAX_SLICE_CHARS);
    lines.push(`Active file ${rel} (around line ${cur + 1}):\n\`\`\`${ed.document.languageId}\n${slice}\n\`\`\``);
  }
  return lines.join('\n');
}

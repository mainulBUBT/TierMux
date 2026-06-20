// Ambient editor context: the active file (a slice around the cursor) and open
// tab names, so the agent knows what you're looking at without an @-mention.
// Sizes trimmed (25→15 lines, 3000→2000 chars) to reduce the per-turn token cost
// against free-tier limits. The active file slice is still large enough for the
// model to see the current function and a bit of context on each side.
import * as vscode from 'vscode';

const SLICE_RADIUS = 15;
const MAX_SLICE_CHARS = 2000;

export function buildAmbientContext(): string {
  if (!vscode.workspace.getConfiguration('tiermux.context').get<boolean>('includeOpenEditors', true)) return '';
  const cfg = vscode.workspace.getConfiguration('tiermux.context');
  const sliceRadius = cfg.get<number>('ambientSliceRadius', SLICE_RADIUS);
  const maxSliceChars = cfg.get<number>('ambientMaxChars', MAX_SLICE_CHARS);
  const maxTabs = cfg.get<number>('ambientMaxTabs', 12);
  const lines: string[] = [];

  try {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : null))
      .filter((x): x is string => !!x);
    const uniq = [...new Set(tabs)].slice(0, maxTabs);
    if (uniq.length) lines.push('Open tabs: ' + uniq.join(', '));
  } catch { /* ignore */ }

  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') {
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const cur = ed.selection.active.line;
    const start = Math.max(0, cur - sliceRadius);
    const end = Math.min(ed.document.lineCount, cur + sliceRadius + 1);
    const slice = ed.document.getText(new vscode.Range(start, 0, end, 0)).slice(0, maxSliceChars);
    lines.push(`Active file ${rel} (around line ${cur + 1}):\n\`\`\`${ed.document.languageId}\n${slice}\n\`\`\``);
  }
  return lines.join('\n');
}


// Auto-enrichment for outgoing prompts: a hidden, MODEL-facing snapshot of the active file,
// selection, cursor and that file's diagnostics (same formatter as the getDiagnostics tool), so
// a bare "fix this" resolves. The visible transcript is untouched. Null when nothing to add.

import * as vscode from 'vscode';
import { formatDiagnosticEntries } from '../agent/core/tools/workspace/formatDiagnostics';

/** Bound the selection snippet so a 2000-line highlight doesn't blow the prompt. */
const MAX_SELECTION_CHARS = 8 * 1024;
const MAX_SELECTION_LINES = 120;
/** Bound diagnostics — five is enough to point the model at the problem without token spam. */
const MAX_DIAGNOSTICS = 5;

/** The workspace-relative path of the active editor, or null if none / not a real file. Used by
 *  callers to dedup against an explicit `@file` mention (see handleSend). */
export function activeEditorRelPath(): string | null {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file') return null;
  return vscode.workspace.asRelativePath(ed.document.uri);
}

/** Build a hidden context block describing the active editor: file, language, and code. When the
 *  user has a selection, that selection is used; otherwise an ambient slice of `sliceRadius` lines
 *  around the cursor (honors `tiermux.context.ambientSliceRadius`, 0 = cursor line only). Returns
 *  null when there is no real file editor open. */
export function buildActiveEditorContext(sliceRadius = 15): string | null {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  const doc = ed.document;
  if (doc.uri.scheme !== 'file') return null; // skip output panels, settings editors, etc.
  const rel = vscode.workspace.asRelativePath(doc.uri);
  // The provenance line is not decoration: without it a model reads this block as a payload the
  // user pasted and answers about it ("the SQL you've provided…") even when the message never
  // mentioned it. Say plainly that the editor produced it and when it is relevant.
  const lines: string[] = [
    `<active_editor file="${rel}" language="${doc.languageId}">`,
    'Automatic snapshot of the editor. The user did NOT send this — use it only to resolve what a'
      + ' vague reference ("this", "here", "the bug") points at, never as the subject of the reply.',
  ];

  const sel = ed.selection;
  if (!sel.isEmpty) {
    const raw = doc.getText(sel).replace(/\t/g, '    ');
    lines.push(`Selected lines ${sel.start.line + 1}-${sel.end.line + 1}:`);
    lines.push('```');
    lines.push(capSnippet(raw));
    lines.push('```');
  } else {
    const cur = sel.active.line;
    if (sliceRadius <= 0) {
      lines.push(`Cursor at line ${cur + 1}`);
    } else {
      const from = Math.max(0, cur - sliceRadius);
      const to = Math.min(doc.lineCount - 1, cur + sliceRadius);
      const range = new vscode.Range(from, 0, to, doc.lineAt(to).text.length);
      const raw = doc.getText(range).replace(/\t/g, '    ');
      lines.push(`Lines ${from + 1}-${to + 1} (cursor on line ${cur + 1}):`);
      lines.push('```');
      lines.push(capSnippet(raw));
      lines.push('```');
    }
  }
  lines.push('</active_editor>');
  return lines.join('\n');
}

/** Build a hidden diagnostics block for the active file (errors + warnings), capped at
 *  MAX_DIAGNOSTICS entries. Returns null when the active file has no diagnostics. */
export function buildDiagnosticsContext(): string | null {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  if (ed.document.uri.scheme !== 'file') return null;
  const uri = ed.document.uri;
  // Errors + warnings only: `'all'` lets INFO squiggles through (e.g. Intelephense's
  // "resolved via __call" hints), and live repro 2026-08-28 — a meaningless
  // "ljdsjcs Idksjls" message made the model latch onto those INFO hints as the only
  // concrete signal and run a full hasRole/Spatie investigation nobody asked for.
  const diags = vscode.languages.getDiagnostics(uri).filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
  );
  if (!diags.length) return null;
  const rel = vscode.workspace.asRelativePath(uri);
  const formatted = formatDiagnosticEntries([[uri, diags]], 'all').slice(0, MAX_DIAGNOSTICS);
  if (!formatted.length) return null;
  const omitted = diags.length - formatted.length;
  const tail = omitted > 0 ? `\n…(${omitted} more)` : '';
  // Same guard as <active_editor>: without a provenance line the block reads as the
  // subject of the turn whenever the user's actual message is vague or unparseable.
  return [
    `<active_diagnostics file="${rel}">`,
    'Automatic editor diagnostics. The user did NOT send this and did not ask about it — background'
      + ' signal only; act on it only when the user\'s request clearly relates to these entries.',
    ...formatted,
    '</active_diagnostics>',
    tail.trimStart(),
  ].join('\n').trimEnd();
}

/** Trim a selection to a sane prompt size: first N lines, then a char ceiling with a marker. */
function capSnippet(text: string): string {
  const byLines = text.split('\n').slice(0, MAX_SELECTION_LINES).join('\n');
  if (byLines.length <= MAX_SELECTION_CHARS) return byLines;
  return `${byLines.slice(0, MAX_SELECTION_CHARS)}\n…(selection truncated)`;
}

import * as vscode from 'vscode';

/** Shared by editFile's post-edit note and the `getDiagnostics` tool so both read identically. */
export function formatDiagnosticEntries(entries: [vscode.Uri, vscode.Diagnostic[]][], severity: 'error' | 'warning' | 'all'): string[] {
  const results: string[] = [];
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  for (const [uri, diags] of entries) {
    if (!diags || diags.length === 0) continue;
    const relPath = workspaceRoot ? uri.fsPath.replace(workspaceRoot + '/', '') : uri.fsPath;

    for (const d of diags) {
      if (severity === 'error' && d.severity !== vscode.DiagnosticSeverity.Error) continue;
      if (severity === 'warning' && d.severity !== vscode.DiagnosticSeverity.Warning) continue;

      const sevStr = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : d.severity === vscode.DiagnosticSeverity.Warning ? 'WARNING' : 'INFO';
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const codeStr = d.code ? ` [${typeof d.code === 'object' ? d.code.value : d.code}]` : '';
      results.push(`${relPath}:${line}:${col} - ${sevStr}${codeStr}: ${d.message}`);
    }
  }
  return results;
}

/** Language servers re-lint asynchronously after an edit lands — reading `getDiagnostics`
 *  immediately can return stale (pre-edit) results. Waits for the next `onDidChangeDiagnostics`
 *  touching `uri`, bounded by `timeoutMs`, so a same-turn verify check reflects the edit that was
 *  just made rather than racing the language server. Resolves with whatever's current either way
 *  (a clean file that never fires a diagnostics event is the common case, not a failure). */
export function waitForDiagnosticsSettled(uri: vscode.Uri, timeoutMs = 1200): Promise<vscode.Diagnostic[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sub.dispose();
      clearTimeout(timer);
      resolve(vscode.languages.getDiagnostics(uri));
    };
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.toString() === uri.toString())) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Prefix of editFile's post-edit diagnostics note — a stable sentinel for callers. */
export const NEW_DIAGNOSTICS_MARKER = '⚠ New diagnostics after this edit:';

/** Wait briefly for language servers to finish re-linting after a batch of edits, then read the
 *  WHOLE-WORKSPACE diagnostic set (vs `waitForDiagnosticsSettled`, which targets one uri). Resolves
 *  on the first `onDidChangeDiagnostics` event of any kind, or the timeout — whichever fires first
 *  — then returns whatever `getDiagnostics()` currently holds. Used by the end-of-turn workspace
 *  verify to catch errors in files OTHER than the one just edited (a cross-file break the per-edit
 *  `verifyNoteFor` check can't see). */
export function waitForWorkspaceDiagnosticsSettled(timeoutMs = 1200): Promise<[vscode.Uri, vscode.Diagnostic[]][]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; sub.dispose(); clearTimeout(timer); resolve(vscode.languages.getDiagnostics()); };
    const sub = vscode.languages.onDidChangeDiagnostics(() => finish());
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** A stable signature for an error diagnostic, used to diff a workspace snapshot taken BEFORE a
 *  turn's edits against one taken AFTER — so the end-of-turn verify can tell which errors the turn
 *  INTRODUCED (vs pre-existing ones the user already had). Keyed on the same relPath:line:message
 *  shape `formatDiagnosticEntries` emits, errors only. */
export function workspaceErrorSignatures(entries: [vscode.Uri, vscode.Diagnostic[]][]): Set<string> {
  return new Set(formatDiagnosticEntries(entries, 'error'));
}

/** Errors that are in `after` but NOT in `before` — i.e. newly introduced since the baseline
 *  snapshot. Returns the formatted one-line strings (relPath:line:col - ERROR: message). */
export function newErrorsSince(before: Set<string>, after: [vscode.Uri, vscode.Diagnostic[]][]): string[] {
  return formatDiagnosticEntries(after, 'error').filter((line) => !before.has(line));
}

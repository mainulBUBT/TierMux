import * as vscode from 'vscode';

/** Shared with diagnostics.ts's own tool output so a post-edit verify line and an explicit
 *  `getDiagnostics` call always read identically to the model. */
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

/** Errors-only, one-line-per-diagnostic verify note appended to an edit/write tool's own result —
 *  empty string when the file is clean, so a healthy edit's result is unchanged. */
export async function verifyNoteFor(uri: vscode.Uri): Promise<string> {
  const diags = await waitForDiagnosticsSettled(uri);
  const lines = formatDiagnosticEntries([[uri, diags]], 'error');
  if (!lines.length) return '';
  return `\n\n⚠ New diagnostics after this edit:\n${lines.join('\n')}`;
}

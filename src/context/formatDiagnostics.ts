import * as vscode from 'vscode';

/** Diagnostics as `path:line:col - SEVERITY: message` lines for the active-editor context. */
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

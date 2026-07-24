import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';

const MAX_CHARS = 12_000;

export function createDiagnosticsTool() {
  return tool({
    description: 'Get active workspace or file diagnostics (linter errors, TypeScript compilation problems, warnings).',
    inputSchema: z.object({
      path: z.string().optional().describe('Workspace-relative file path to inspect (omit to inspect all workspace diagnostics).'),
      severity: z.enum(['error', 'warning', 'all']).optional().describe('Filter by severity: "error", "warning", or "all" (default: "all").'),
    }),
    execute: async ({ path: relativePath, severity = 'all' }: { path?: string; severity?: 'error' | 'warning' | 'all' }) => {
      let entries: [vscode.Uri, vscode.Diagnostic[]][];

      if (relativePath) {
        const uri = resolveWorkspacePath(relativePath);
        const diags = vscode.languages.getDiagnostics(uri);
        entries = [[uri, diags]];
      } else {
        entries = vscode.languages.getDiagnostics();
      }

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

      if (results.length === 0) {
        return relativePath
          ? `No diagnostics found for ${relativePath}.`
          : 'No workspace diagnostics or errors found.';
      }

      return capToolOutput(
        results.join('\n'),
        MAX_CHARS,
        'Narrow diagnostic check to a specific file using the "path" parameter.'
      );
    },
  });
}

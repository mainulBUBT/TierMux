// v3 getDiagnostics — read the language servers' current view of the workspace (or one file).
// Read-only, auto-approved by the policy (already in READ_ONLY_TOOLS). Reuses the shared
// formatters so its output reads identically to the post-edit verify notes editFile appends.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';
import {
  formatDiagnosticEntries,
  waitForDiagnosticsSettled,
  waitForWorkspaceDiagnosticsSettled,
} from '../workspace/formatDiagnostics';

export function createGetDiagnosticsTool() {
  return tool({
    description:
      'Get current editor diagnostics (errors/warnings) for one file or the whole workspace. '
      + 'Use after edits or when the user reports a problem — cheaper than running the build.',
    inputSchema: z.object({
      path: z.string().optional().describe('Workspace-relative file to scope to; omit for the whole workspace.'),
      severity: z.enum(['error', 'warning', 'all']).optional().describe('Filter (default: all).'),
    }),
    execute: async ({ path, severity }): Promise<string | { error: string }> => {
      try {
        if (path) {
          const uri = resolveWorkspacePath(path);
          await waitForDiagnosticsSettled(uri, 800);
          const lines = formatDiagnosticEntries([[uri, vscode.languages.getDiagnostics(uri)]], severity ?? 'all');
          return lines.length
            ? capToolOutput(lines.join('\n'), 8_000, 'Narrow with "path" or severity:"error".')
            : `No diagnostics for ${path}.`;
        }
        await waitForWorkspaceDiagnosticsSettled(800);
        const lines = formatDiagnosticEntries(vscode.languages.getDiagnostics(), severity ?? 'all');
        return lines.length
          ? capToolOutput(lines.join('\n'), 8_000, 'Narrow with "path" or severity:"error".')
          : 'No diagnostics in the workspace.';
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

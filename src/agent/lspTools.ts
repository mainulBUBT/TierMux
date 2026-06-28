// VS Code LSP as Vercel AI SDK v7 tool() definitions.
// Replaces OpenCode's 29 language servers — same data via VS Code built-in LSP.
import { tool } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import * as vscode from 'vscode';

function fsUri(file: string): vscode.Uri {
  return file.startsWith('/') ? vscode.Uri.file(file) : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, file);
}

export const lspTools = {
  goToDefinition: tool({
    description: 'Find where a symbol is defined. Provide the file path, line (0-based) and character offset of the symbol name.',
    inputSchema: z.object({
      file: z.string().describe('Absolute or workspace-relative file path.'),
      line: z.number().int().describe('0-based line number of the symbol.'),
      character: z.number().int().describe('0-based character offset of the symbol.'),
    }),
    execute: async ({ file, line, character }) => {
      const uri = fsUri(file);
      const pos = new vscode.Position(line, character);
      const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeDefinitionProvider', uri, pos,
      );
      if (!defs?.length) return { locations: [] };
      return {
        locations: (defs as any[]).map(d => {
          const loc = 'targetUri' in d ? { uri: d.targetUri, range: d.targetRange } : d;
          return { file: loc.uri.fsPath, line: loc.range.start.line, character: loc.range.start.character };
        }),
      };
    },
  }),

  findReferences: tool({
    description: 'Find all usages of a symbol across the workspace.',
    inputSchema: z.object({
      file: z.string().describe('File path where the symbol appears.'),
      line: z.number().int().describe('0-based line number.'),
      character: z.number().int().describe('0-based character offset.'),
      includeDeclaration: z.boolean().optional().describe('Whether to include the declaration itself. Default true.'),
    }),
    execute: async ({ file, line, character, includeDeclaration = true }) => {
      const uri = fsUri(file);
      const pos = new vscode.Position(line, character);
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', uri, pos, { includeDeclaration },
      );
      if (!refs?.length) return { references: [] as Array<{ file: string; line: number; character: number }>, total: 0 };
      return {
        references: refs.map(r => ({
          file: r.uri.fsPath,
          line: r.range.start.line,
          character: r.range.start.character,
        })),
        total: refs.length,
      };
    },
  }),

  getDiagnostics: tool({
    description: 'Get type errors, warnings and lint issues in a file from the active language server.',
    inputSchema: z.object({
      file: z.string().describe('Absolute or workspace-relative file path.'),
    }),
    execute: async ({ file }) => {
      const uri = fsUri(file);
      const diags = vscode.languages.getDiagnostics(uri);
      return {
        diagnostics: diags.map(d => ({
          line: d.range.start.line,
          character: d.range.start.character,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error'
            : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning'
            : d.severity === vscode.DiagnosticSeverity.Information ? 'info' : 'hint',
          message: d.message,
          source: d.source,
          code: d.code?.toString(),
        })),
        errors: diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length,
        warnings: diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length,
      };
    },
  }),

  getDocumentSymbols: tool({
    description: 'List all symbols (functions, classes, variables, types) defined in a file.',
    inputSchema: z.object({
      file: z.string().describe('Absolute or workspace-relative file path.'),
    }),
    execute: async ({ file }) => {
      const uri = fsUri(file);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri,
      );
      if (!symbols?.length) return { symbols: [] as Array<{ name: string; kind: string; line: number; detail?: string; depth: number }> };

      function flatten(syms: vscode.DocumentSymbol[], depth = 0): Array<{ name: string; kind: string; line: number; detail?: string; depth: number }> {
        return syms.flatMap(s => [
          { name: s.name, kind: vscode.SymbolKind[s.kind], line: s.range.start.line, detail: s.detail || undefined, depth },
          ...flatten(s.children ?? [], depth + 1),
        ]);
      }

      return { symbols: flatten(symbols) };
    },
  }),

  searchWorkspaceSymbols: tool({
    description: 'Search for symbols (functions, classes, types) by name across all workspace files.',
    inputSchema: z.object({
      query: z.string().describe('Symbol name or partial name to search for.'),
    }),
    execute: async ({ query }) => {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', query,
      );
      if (!symbols?.length) return { symbols: [] as Array<{ name: string; kind: string; file: string; line: number; containerName?: string }>, total: 0 };
      return {
        symbols: symbols.slice(0, 50).map(s => ({
          name: s.name,
          kind: vscode.SymbolKind[s.kind],
          file: s.location.uri.fsPath,
          line: s.location.range.start.line,
          containerName: s.containerName || undefined,
        })),
        total: symbols.length,
      };
    },
  }),

  getHover: tool({
    description: 'Get type information and documentation for a symbol at a position (like hovering in the editor).',
    inputSchema: z.object({
      file: z.string().describe('File path.'),
      line: z.number().int().describe('0-based line number.'),
      character: z.number().int().describe('0-based character offset.'),
    }),
    execute: async ({ file, line, character }) => {
      const uri = fsUri(file);
      const pos = new vscode.Position(line, character);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, pos,
      );
      if (!hovers?.length) return { hover: null as string | null };
      const text = hovers
        .flatMap(h => h.contents)
        .map(c => typeof c === 'string' ? c : (c as any).value ?? '')
        .join('\n')
        .trim();
      return { hover: text || null };
    },
  }),
};

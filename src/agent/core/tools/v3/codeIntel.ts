// outline / findSymbol / references / definition / hover — the editor's language servers as read-only
// tools. One call answers what a grep-then-read chain needs several round trips for. Nothing here
// indexes anything: VS Code already runs the language servers, so this is zero new dependencies and
// works for every language that has one. `outline` falls back to the regex extractor when no
// server answers (a language without an extension, or a server still starting).

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveReadablePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';
import { extract } from '../../../../context/symbolExtract';
import { diagLog } from '../../../../util/diag';

const MAX_CHARS = 10_000;
const MAX_OUTLINE_LINES = 300;
const MAX_FIND = 30;
const MAX_REFS = 40;

export type Exec = <T>(command: string, ...args: unknown[]) => PromiseLike<T | undefined>;
const liveExec: Exec = (command, ...args) => vscode.commands.executeCommand(command, ...args);

type Log = (scope: string, msg: string) => void;

/** A language server that answers nothing is not an answer. Tell the model AT ONCE to fall back —
 *  no wait, no retry (zero added latency) — and log it so how often it happens can be measured
 *  before any retry is even considered. */
function noResult(log: Log, command: string, subject: string, what: string, fallback = 'grep or glob'): string {
  log('codeIntel.empty', `${command} · ${subject}`);
  return `No ${what}. The language server returned no result (it may still be indexing, or not cover this language) — use ${fallback} instead.`;
}

// vscode.SymbolKind numbering (0-based) — a local table so the tools do not depend on the enum
// object being present (headless/e2e mocks).
const KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
  'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object',
  'key', 'null', 'enum-member', 'struct', 'event', 'operator', 'type-param'];
const kindName = (k: number): string => KINDS[k] ?? 'symbol';

interface DocSymbolLike {
  name: string; kind: number;
  range?: { start: { line: number }; end: { line: number } };
  selectionRange?: { start: { line: number; character: number } };
  location?: { range: { start: { line: number }; end: { line: number } } };
  children?: DocSymbolLike[];
}

function lineRange(s: DocSymbolLike): { from: number; to: number } {
  const r = s.range ?? s.location?.range;
  return { from: (r?.start.line ?? 0) + 1, to: (r?.end.line ?? 0) + 1 };
}

/** Pure: a symbol tree → indented `kind name  Lfrom-to` lines (depth-capped, count-capped). */
export function formatOutline(symbols: DocSymbolLike[], maxDepth = 2): string[] {
  const out: string[] = [];
  const walk = (list: DocSymbolLike[], depth: number) => {
    for (const s of list) {
      if (out.length >= MAX_OUTLINE_LINES) return;
      const { from, to } = lineRange(s);
      out.push(`${'  '.repeat(depth)}${kindName(s.kind)} ${s.name}  L${from}${to > from ? `-${to}` : ''}`);
      if (s.children?.length && depth < maxDepth) walk(s.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return out;
}

const rel = (uri: vscode.Uri): string => vscode.workspace.asRelativePath(uri);

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
}

export function createOutlineTool(exec: Exec = liveExec, log: Log = diagLog) {
  return tool({
    description:
      'List the symbols (classes, functions, methods, …) declared in ONE file with their line ranges, '
      + 'from the editor\'s language server. Use it to see a file\'s shape and pick the exact `offset`/`limit` '
      + 'for readFile instead of paging blindly. Not for finding WHERE something is across the repo — use findSymbol or grep.',
    inputSchema: z.object({ path: z.string().describe('Workspace-relative file path.') }),
    execute: async ({ path }): Promise<string | { error: string }> => {
      try {
        if (!path) return { error: 'Missing required "path" argument.' };
        const uri = resolveReadablePath(path);
        const text = await readText(uri);
        if (text === undefined) return { error: `File not found: ${path}` };
        const symbols = (await exec<DocSymbolLike[]>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
        if (symbols.length) return capToolOutput(`<outline path="${path}" lines="${text.split('\n').length}">\n${formatOutline(symbols).join('\n')}\n</outline>`, MAX_CHARS, 'Read a narrower part of the file.');
        log('codeIntel.empty', `executeDocumentSymbolProvider · ${path}`);
        const fallback = extract(path, text).symbols;
        if (!fallback.length) return `No symbols found in ${path} (no language server answered and the file has no recognisable declarations).`;
        return capToolOutput(`<outline path="${path}" lines="${text.split('\n').length}" source="regex — no language server result">\n${fallback.map((s) => `${s.kind} ${s.name}  L${s.line}`).join('\n')}\n</outline>`, MAX_CHARS, 'Read a narrower part of the file.');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

export function createFindSymbolTool(exec: Exec = liveExec, log: Log = diagLog) {
  return tool({
    description:
      'Find where a class / function / method / type is DECLARED anywhere in the workspace, by (partial) name, '
      + 'using the language servers. Returns `kind name — path:line`. Prefer this over grep when you know the '
      + 'symbol\'s name; use grep for arbitrary text.',
    inputSchema: z.object({ query: z.string().min(1).describe('Symbol name or a fragment of it.') }),
    execute: async ({ query }): Promise<string | { error: string }> => {
      try {
        const found = (await exec<Array<DocSymbolLike & { containerName?: string; location: { uri: vscode.Uri; range: { start: { line: number } } } }>>(
          'vscode.executeWorkspaceSymbolProvider', query.trim())) ?? [];
        const lines = found
          .filter((s) => !/(^|\/)node_modules\//.test(rel(s.location.uri)))
          .slice(0, MAX_FIND)
          .map((s) => `${kindName(s.kind)} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${rel(s.location.uri)}:${s.location.range.start.line + 1}`);
        return lines.length ? lines.join('\n') : noResult(log, 'executeWorkspaceSymbolProvider', query, `symbol matching "${query}"`);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

/** Where `symbol` sits in `text`: on `line` (1-based) when given, else its first whole-word hit. */
export function locateSymbol(text: string, symbol: string, line?: number): { line: number; character: number } | undefined {
  const lines = text.split('\n');
  const re = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
  const candidates = line && line >= 1 && line <= lines.length ? [line - 1] : lines.map((_, i) => i);
  for (const i of candidates) {
    const m = re.exec(lines[i]);
    if (m) return { line: i, character: m.index };
  }
  return undefined;
}

interface LocLike { uri?: vscode.Uri; range?: { start: { line: number } }; targetUri?: vscode.Uri; targetRange?: { start: { line: number } } }

async function formatLocations(locs: LocLike[], cap: number): Promise<string[]> {
  const cache = new Map<string, string[] | undefined>();
  const out: string[] = [];
  for (const l of locs.slice(0, cap)) {
    const uri = l.targetUri ?? l.uri;
    const start = (l.targetRange ?? l.range)?.start.line;
    if (!uri || start === undefined) continue;
    const key = uri.toString();
    if (!cache.has(key)) cache.set(key, (await readText(uri))?.split('\n'));
    const snippet = cache.get(key)?.[start]?.trim().slice(0, 140) ?? '';
    out.push(`${rel(uri)}:${start + 1}  ${snippet}`);
  }
  return out;
}

const positionSchema = {
  path: z.string().describe('Workspace-relative file where the symbol appears.'),
  symbol: z.string().min(1).describe('The symbol name exactly as written in that file.'),
  line: z.number().int().positive().optional().describe('1-based line to look on when the name appears several times (default: its first occurrence).'),
};

async function withPosition(
  args: { path: string; symbol: string; line?: number },
  run: (uri: vscode.Uri, pos: vscode.Position) => Promise<string>,
): Promise<string | { error: string }> {
  try {
    const uri = resolveReadablePath(args.path);
    const text = await readText(uri);
    if (text === undefined) return { error: `File not found: ${args.path}` };
    const at = locateSymbol(text, args.symbol, args.line);
    if (!at) return { error: `"${args.symbol}" not found in ${args.path}${args.line ? ` on line ${args.line}` : ''}.` };
    return await run(uri, new vscode.Position(at.line, at.character));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function createReferencesTool(exec: Exec = liveExec, log: Log = diagLog) {
  return tool({
    description:
      'List every place a symbol is USED (call sites, imports, type uses) across the workspace, from the '
      + 'language servers — the reliable way to find all call sites before changing a signature. Returns '
      + '`path:line  <code>`. Set `kind` for a different view: "implementations" (classes implementing an '
      + 'interface or abstract method), "incomingCalls" (who calls it), "outgoingCalls" (what it calls). '
      + 'If the server returns nothing, use grep.',
    inputSchema: z.object({
      ...positionSchema,
      kind: z.enum(['references', 'implementations', 'incomingCalls', 'outgoingCalls']).optional()
        .describe('What to list (default "references").'),
    }),
    execute: (args) => withPosition(args, async (uri, pos) => {
      const kind = args.kind ?? 'references';
      if (kind === 'incomingCalls' || kind === 'outgoingCalls') {
        const items = (await exec<CallItem[]>('vscode.prepareCallHierarchy', uri, pos)) ?? [];
        const cmd = kind === 'incomingCalls' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls';
        const calls = items.length ? ((await exec<Array<{ from?: CallItem; to?: CallItem }>>(cmd, items[0])) ?? []) : [];
        const lines = calls
          .map((c) => c.from ?? c.to)
          .filter((i): i is CallItem => !!i)
          .slice(0, MAX_REFS)
          .map((i) => `${kindName(i.kind)} ${i.name} — ${rel(i.uri)}:${i.range.start.line + 1}`);
        if (!lines.length) return noResult(log, cmd.replace('vscode.', ''), args.symbol, `${kind === 'incomingCalls' ? 'callers' : 'callees'} found for "${args.symbol}"`);
        return capToolOutput(`${kind === 'incomingCalls' ? 'Callers of' : 'Calls made by'} "${args.symbol}":\n${lines.join('\n')}`, MAX_CHARS, 'Ask for a narrower symbol.');
      }
      const command = kind === 'implementations' ? 'vscode.executeImplementationProvider' : 'vscode.executeReferenceProvider';
      const locs = (await exec<LocLike[]>(command, uri, pos)) ?? [];
      if (!locs.length) return noResult(log, command.replace('vscode.', ''), args.symbol, `${kind} found for "${args.symbol}"`);
      const lines = await formatLocations(locs, MAX_REFS);
      return capToolOutput(`${locs.length} ${kind === 'implementations' ? 'implementation(s) of' : 'reference(s) to'} "${args.symbol}":\n${lines.join('\n')}${locs.length > MAX_REFS ? `\n…[showing ${MAX_REFS} of ${locs.length}]` : ''}`, MAX_CHARS, 'Ask for a narrower symbol.');
    }),
  });
}

interface CallItem { name: string; kind: number; uri: vscode.Uri; range: { start: { line: number } } }

export function createDefinitionTool(exec: Exec = liveExec, log: Log = diagLog) {
  return tool({
    description:
      'Jump to where a symbol used in a file is DEFINED (follows imports and re-exports), from the language '
      + 'servers. Returns `path:line  <declaration>`; then readFile that range.',
    inputSchema: z.object(positionSchema),
    execute: (args) => withPosition(args, async (uri, pos) => {
      const locs = (await exec<LocLike[]>('vscode.executeDefinitionProvider', uri, pos)) ?? [];
      if (!locs.length) return noResult(log, 'executeDefinitionProvider', args.symbol, `definition found for "${args.symbol}"`, 'findSymbol or grep');
      return (await formatLocations(locs, 10)).join('\n');
    }),
  });
}

/** A hover `contents` entry is a string, a MarkdownString, or a `{language, value}` MarkedString. */
function hoverText(c: unknown): string {
  if (typeof c === 'string') return c;
  const v = (c as { value?: unknown } | null)?.value;
  return typeof v === 'string' ? v : '';
}

export function createHoverTool(exec: Exec = liveExec, log: Log = diagLog) {
  return tool({
    description:
      'Show the type signature and documentation the language server has for a symbol used in a file (what an '
      + 'editor hover shows) — cheaper than reading the declaration when you only need its type or docs. '
      + 'If the server returns nothing, read the declaration instead.',
    inputSchema: z.object(positionSchema),
    execute: (args) => withPosition(args, async (uri, pos) => {
      const hovers = (await exec<Array<{ contents?: unknown[] }>>('vscode.executeHoverProvider', uri, pos)) ?? [];
      const text = hovers.flatMap((h) => h.contents ?? []).map(hoverText).filter(Boolean).join('\n---\n').trim();
      if (!text) return noResult(log, 'executeHoverProvider', args.symbol, `type information for "${args.symbol}"`, 'definition + readFile');
      return capToolOutput(text, 3_000, 'Use definition + readFile for the full declaration.');
    }),
  });
}

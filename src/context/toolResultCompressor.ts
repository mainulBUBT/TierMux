// Tool result compressor — converts raw grep/glob/readFile output into structured summaries
// before they enter the LLM message history.
//
// Two-layer output design:
//   Model-facing  → short aliases + layer labels  (fewer tokens, faster reading)
//   Tool-facing   → full relative paths            (resolver map, used at tool-call time)
//
// Model sees "[service] ContributionService.php:302 updateUserReputation()" and calls
// readFile("ContributionService.php"). The resolver transparently:
//   1. Rewrites to full path  app/Services/ContributionService.php
//   2. Validates the path still exists (TTL — stale after rename/delete)
//   3. Injects startLine=292 endLine=342 for a 50-line narrow read

import { inferLayer, type StructuralGraph } from './structuralGraph';

// ---- Constants ----
const COMPRESS_THRESHOLD_CHARS = 400;
const MAX_SYMBOL_HITS = 8;
const MAX_FILES = 6;
const MAX_EXCERPT_LINES = 2;
const NARROW_WINDOW = 50;   // total lines for symbol-first reads
const NARROW_BEFORE = 10;   // lines before the hit (function signature context)

// ---- Layer labels ----
const LAYER_LABEL: Record<string, string> = {
  api:     'controller',
  service: 'service',
  data:    'model',
  ui:      'component',
  utility: 'util',
  test:    'test',
  config:  'config',
};

function fileLabel(filePath: string): string {
  return LAYER_LABEL[inferLayer(filePath)] ?? '';
}

function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
}

// ---- Alias disambiguation ----
// When two files share a basename (e.g. Services/UserService.php and Admin/UserService.php),
// auto-upgrade to parent/basename to keep aliases unique.

function makeAliasMap(fullPaths: string[]): Map<string, string> {
  // Count how many paths share each basename
  const bnCount = new Map<string, number>();
  for (const fp of fullPaths) {
    const bn = basename(fp);
    bnCount.set(bn, (bnCount.get(bn) ?? 0) + 1);
  }

  // Build alias: bare basename when unique, parent/basename on collision
  const aliasMap = new Map<string, string>(); // fullPath → alias
  const aliasSet = new Set<string>();          // used aliases
  for (const fp of fullPaths) {
    const bn = basename(fp);
    if ((bnCount.get(bn) ?? 1) <= 1) {
      aliasMap.set(fp, bn);
      aliasSet.add(bn);
    } else {
      const parts = fp.replace(/\\/g, '/').split('/');
      const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
      const disambig = parent ? `${parent}/${bn}` : bn;
      aliasMap.set(fp, disambig);
      aliasSet.add(disambig);
    }
  }
  return aliasMap;
}

// ---- Layer ordering ----
const LAYER_PRIORITY: Record<string, number> = {
  api: 0, service: 1, data: 2, ui: 3, utility: 4, config: 5, test: 6, unknown: 7,
};

// ---- Definition detection ----
const DEF_RE = /(?:^|\s)(?:(?:public|private|protected|static|async|export|abstract|override|pub|open|sealed|final)\s+)*(?:(?:function|func|fn|def|fun)\s+(\w+)|(?:class|interface|trait|enum|struct|record|object)\s+(\w+)|(\w+)\s*[=:]\s*(?:async\s*)?(?:function|\(.*?\)\s*=>|\(.*?\)\s*->))/;

function extractDefName(content: string): string | undefined {
  const m = DEF_RE.exec(content);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? m[3])?.trim();
}

const STOP = new Set(['true', 'false', 'null', 'undefined', 'return', 'const', 'class', 'function', 'import', 'export', 'async', 'await']);
function extractSymbolNames(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\b([A-Z][a-zA-Z0-9]{2,}|[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+)\b/g)) {
    if (!STOP.has(m[1])) out.push(m[1]);
  }
  return out;
}

// ---- Grep line parsing ----
interface Hit {
  file: string;
  line: number;
  content: string;
  defName?: string;
}

const GREP_LINE_RE = /^([\w./\\-]+\.[a-zA-Z]{1,6}):(\d+):\s*(.{0,180})/gm;

function parseGrepHits(raw: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of raw.matchAll(GREP_LINE_RE)) {
    const [, file, lineStr, content] = m;
    hits.push({ file, line: parseInt(lineStr, 10), content: content.trim(), defName: extractDefName(content) });
  }
  return hits;
}

// ---- FLOW chain ----
function buildFlowChain(files: string[], graph: StructuralGraph): string | null {
  if (files.length < 2) return null;

  const sorted = [...files].sort((a, b) =>
    (LAYER_PRIORITY[inferLayer(a)] ?? 7) - (LAYER_PRIORITY[inferLayer(b)] ?? 7),
  );

  const fileSet = new Set(files.map((f) => f.toLowerCase()));
  const edges = new Map<string, string>();
  for (const imp of graph.imports) {
    const fromN = imp.from.toLowerCase();
    const toN = imp.to.toLowerCase();
    if (fileSet.has(fromN) && fileSet.has(toN) && fromN !== toN && !edges.has(fromN)) {
      edges.set(fromN, imp.to);
    }
  }
  for (const call of graph.calls) {
    const fromN = call.from.toLowerCase();
    const toN = call.to.toLowerCase();
    if (fileSet.has(fromN) && fileSet.has(toN) && fromN !== toN && !edges.has(fromN)) {
      edges.set(fromN, call.to);
    }
  }

  const chain: string[] = [sorted[0]];
  const visited = new Set([sorted[0].toLowerCase()]);
  let current = sorted[0].toLowerCase();
  for (let i = 0; i < 4; i++) {
    const next = edges.get(current);
    if (!next || visited.has(next.toLowerCase())) break;
    chain.push(next);
    visited.add(next.toLowerCase());
    current = next.toLowerCase();
  }

  if (chain.length < 2) return null;

  return chain
    .map((f, i) => {
      const name = basename(f).replace(/\.[^.]+$/, '');
      return i === 0 ? name : `${'  '.repeat(i)}→ ${name}`;
    })
    .join('\n');
}

// ---- Public types ----

/**
 * One entry in the path resolver.
 * alias (model-facing) → { path (tool-facing), line? (for narrow reads) }
 */
export interface ResolverEntry {
  /** Full relative path — what tools receive. */
  path: string;
  /** Line number from SYMBOL_HITS — used to inject startLine/endLine on readFile. */
  line?: number;
}

/** Compressed tool result + resolver map for path aliasing and narrow reads. */
export interface CompressedToolResult {
  /** What the model sees — short aliases with layer labels. */
  text: string;
  /**
   * alias → ResolverEntry
   * Alias is either bare basename (ContributionService.php) or parent/basename
   * when two files share the same basename (Services/UserService.php).
   */
  resolver: Map<string, ResolverEntry>;
}

// ---- Grep compressor ----

export function compressGrepResult(
  raw: string,
  searchTerm?: string,
  graph?: StructuralGraph,
): CompressedToolResult {
  const empty: CompressedToolResult = { text: raw, resolver: new Map() };
  if (!raw || raw.length <= COMPRESS_THRESHOLD_CHARS) return empty;

  const hits = parseGrepHits(raw);
  if (!hits.length) return empty;

  // Unique full paths (insertion order = appearance order)
  const fullPaths: string[] = [];
  for (const h of hits) {
    if (!fullPaths.includes(h.file)) fullPaths.push(h.file);
  }

  // Build alias map (handles collision → parent/basename)
  const aliasMap = makeAliasMap(fullPaths);

  // Symbols: defs first, then PascalCase/camelCase identifiers
  const seen = new Set<string>();
  const symbols: Array<{ name: string; file: string; line: number; isDef: boolean }> = [];
  for (const h of hits) {
    if (h.defName && !seen.has(h.defName)) {
      seen.add(h.defName);
      symbols.push({ name: h.defName, file: h.file, line: h.line, isDef: true });
    }
  }
  for (const h of hits) {
    for (const name of extractSymbolNames(h.content)) {
      if (!seen.has(name) && symbols.length < MAX_SYMBOL_HITS) {
        seen.add(name);
        symbols.push({ name, file: h.file, line: h.line, isDef: false });
      }
    }
  }

  // Build resolver: alias → { path, line }
  // Line hint = earliest SYMBOL_HIT line for that file (def preferred over ref)
  const resolver = new Map<string, ResolverEntry>();
  for (const fp of fullPaths) {
    const alias = aliasMap.get(fp) ?? basename(fp);
    if (!resolver.has(alias)) resolver.set(alias, { path: fp });
  }
  for (const s of symbols) {
    const alias = aliasMap.get(s.file) ?? basename(s.file);
    const entry = resolver.get(alias);
    if (entry && !entry.line) {
      resolver.set(alias, { ...entry, line: s.line });
    }
  }

  const lines: string[] = [];

  if (searchTerm) {
    lines.push(`grep "${searchTerm}" → ${hits.length} match${hits.length === 1 ? '' : 'es'} in ${fullPaths.length} file${fullPaths.length === 1 ? '' : 's'}`);
    lines.push('');
  }

  // SYMBOL_HITS — model-facing: [label] alias:line  symbol()
  if (symbols.length) {
    lines.push('## SYMBOL_HITS');
    for (const s of symbols) {
      const alias = aliasMap.get(s.file) ?? basename(s.file);
      const label = fileLabel(s.file);
      const prefix = label ? `[${label}] ` : '';
      lines.push(`${prefix}${alias}:${s.line}  ${s.name}${s.isDef ? '()' : ''}`);
    }
    lines.push('');
  }

  // FLOW — relationship chain (class-like names, no paths needed)
  if (graph && fullPaths.length >= 2) {
    const flow = buildFlowChain(fullPaths.slice(0, MAX_FILES), graph);
    if (flow) {
      lines.push('## FLOW');
      lines.push(flow);
      lines.push('');
    }
  }

  // FILES — full paths with labels for navigation
  lines.push('## FILES');
  for (const fp of fullPaths.slice(0, MAX_FILES)) {
    const label = fileLabel(fp);
    const labelStr = label ? `  [${label}]` : '';
    lines.push(`${fp}${labelStr}`);
  }
  if (fullPaths.length > MAX_FILES) {
    lines.push(`(+${fullPaths.length - MAX_FILES} more)`);
  }

  // EXCERPT — def lines only (2 max)
  const excerpts = hits.filter((h) => h.defName).slice(0, MAX_EXCERPT_LINES);
  if (excerpts.length) {
    lines.push('');
    lines.push('## EXCERPT');
    for (const h of excerpts) {
      lines.push(`${h.file}:${h.line}: ${h.content.slice(0, 80)}`);
    }
  }

  return { text: lines.join('\n'), resolver };
}

// ---- ReadFile compressor ----

const READ_COMPRESS_THRESHOLD = 3000;
const MAX_OUTLINE_SYMBOLS = 12;

export function compressReadFileResult(raw: string, filePath: string): string {
  if (!raw || raw.length <= READ_COMPRESS_THRESHOLD) return raw;

  const fileLines = raw.split('\n');
  const defLines: Array<{ line: number; name: string }> = [];
  for (let i = 0; i < fileLines.length; i++) {
    const defName = extractDefName(fileLines[i]);
    if (defName && defLines.length < MAX_OUTLINE_SYMBOLS) {
      defLines.push({ line: i + 1, name: defName });
    }
  }

  if (!defLines.length) {
    return raw.slice(0, READ_COMPRESS_THRESHOLD) +
      `\n\n[... ${raw.length - READ_COMPRESS_THRESHOLD} more chars — use readFile with startLine/endLine to read a specific section]`;
  }

  return [
    `## OUTLINE: ${filePath} (${fileLines.length} lines)`,
    ...defLines.map((d) => `  :${d.line}  ${d.name}()`),
    '',
    raw,
  ].join('\n');
}

// ---- Path resolver ----

/**
 * Rewrite tool arguments before executeToolCall:
 *   1. Alias → full path  (model used short name, tool needs real path)
 *   2. TTL check via validate()  (file may have been renamed/deleted)
 *   3. Narrow read injection  (readFile gets startLine/endLine from SYMBOL_HIT line)
 *
 * validate(fullPath) should return false if the file no longer exists —
 * the caller is responsible for removing the stale alias from the resolver.
 */
export function resolveToolArgs(
  toolName: string,
  argsJson: string,
  resolver: Map<string, ResolverEntry>,
  validate?: (fullPath: string) => boolean,
): string {
  if (!resolver.size) return argsJson;

  const PATH_TOOLS = new Set([
    'readFile', 'editFile', 'writeFile', 'createFile', 'deleteFile', 'readDocument', 'readImage',
  ]);
  if (!PATH_TOOLS.has(toolName)) return argsJson;

  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const pathKey = args['path'] !== undefined ? 'path'
      : args['filePath'] !== undefined ? 'filePath'
      : undefined;
    if (!pathKey) return argsJson;

    const requested = String(args[pathKey]);
    const entry = resolver.get(requested);
    if (!entry) return argsJson; // full path or unknown alias — pass through unchanged

    // TTL: validate the resolved path still exists
    if (validate && !validate(entry.path)) {
      // Stale alias — remove it and let the model use the full path on retry
      resolver.delete(requested);
      return argsJson;
    }

    const newArgs: Record<string, unknown> = { ...args, [pathKey]: entry.path };

    // Symbol-first narrow read: only for readFile, only when model hasn't specified a range,
    // and only when we have a reliable line hint from SYMBOL_HITS.
    if (
      toolName === 'readFile'
      && entry.line
      && args['startLine'] === undefined
      && args['endLine'] === undefined
    ) {
      newArgs['startLine'] = Math.max(1, entry.line - NARROW_BEFORE);
      newArgs['endLine'] = entry.line + (NARROW_WINDOW - NARROW_BEFORE);
    }

    return JSON.stringify(newArgs);
  } catch {
    return argsJson;
  }
}

// ---- Main dispatcher ----

export function compressToolResult(
  toolName: string,
  raw: string,
  toolArgs?: string,
  graph?: StructuralGraph,
): CompressedToolResult {
  if (!raw) return { text: raw, resolver: new Map() };

  if (toolName === 'grep') {
    let term: string | undefined;
    try {
      const parsed = JSON.parse(toolArgs ?? '{}') as { pattern?: string; query?: string };
      term = parsed.pattern ?? parsed.query;
    } catch { /**/ }
    return compressGrepResult(raw, term, graph);
  }

  if (toolName === 'readFile' || toolName === 'readDocument') {
    let filePath = '';
    try {
      const parsed = JSON.parse(toolArgs ?? '{}') as { path?: string };
      filePath = parsed.path ?? '';
    } catch { /**/ }
    return { text: compressReadFileResult(raw, filePath), resolver: new Map() };
  }

  return { text: raw, resolver: new Map() };
}

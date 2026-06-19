import * as vscode from 'vscode';
import { contentHash, loadVersion, saveVersion, computeWorkspaceHash, detectChanges } from './graphVersion';
import { detectEntrypoints, type EntrypointInfo } from './entrypointDetection';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.venv/**}';
const SUPPORTED_EXTS = '**/*.{ts,tsx,js,jsx,mjs,cjs}';
const MAX_FILES = 800;

const GRAPH_DIR = '.tiermux/graph';
const STRUCTURAL_FILE = 'structural.json';

export interface ExportInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'let' | 'var' | 'default' | 'enum';
  line: number;
}

export interface ImportEdge {
  from: string;
  to: string;
  specifiers: string[];
  line: number;
}

export interface CallEdge {
  from: string;
  to: string;
  callSite: string;
  line: number;
}

export interface FileNode {
  path: string;
  hash: string;
  exports: ExportInfo[];
  layer: LayerTag;
  isEntrypoint: boolean;
  entrypointReason?: string;
}

export type LayerTag = 'api' | 'service' | 'data' | 'ui' | 'utility' | 'test' | 'config' | 'unknown';

export interface StructuralGraph {
  files: FileNode[];
  imports: ImportEdge[];
  calls: CallEdge[];
  entrypoints: EntrypointInfo[];
  builtAt: string;
  version: number;
}

function graphDirUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, GRAPH_DIR) : undefined;
}

function structuralUri(): vscode.Uri | undefined {
  const dir = graphDirUri();
  return dir ? vscode.Uri.joinPath(dir, STRUCTURAL_FILE) : undefined;
}

export async function loadStructuralGraph(): Promise<StructuralGraph | undefined> {
  const uri = structuralUri();
  if (!uri) return undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(new TextDecoder().decode(bytes)) as StructuralGraph;
  } catch {
    return undefined;
  }
}

async function saveStructuralGraph(graph: StructuralGraph): Promise<void> {
  const dir = graphDirUri();
  const uri = structuralUri();
  if (!dir || !uri) return;
  try { await vscode.workspace.fs.createDirectory(dir); } catch { /* exists */ }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(graph)));
}

export function inferLayer(filePath: string): LayerTag {
  const p = filePath.toLowerCase();
  if (/\b(test|__tests?__|spec|__spec__)\b/.test(p) || /\.test\.\w+$/.test(p) || /\.spec\.\w+$/.test(p)) return 'test';
  if (/\b(routes?|controllers?|api|endpoints?|handlers?)\b/.test(p)) return 'api';
  if (/\b(services?|business|domain|use-?cases?)\b/.test(p)) return 'service';
  if (/\b(models?|db|database|repositories?|entities?|schemas?|migrations?|dao)\b/.test(p)) return 'data';
  if (/\b(components?|ui|pages?|views?|layouts?|widgets?|screens?)\b/.test(p)) return 'ui';
  if (/\b(utils?|helpers?|lib|common|shared|constants?|types?)\b/.test(p)) return 'utility';
  if (/\b(config|configuration|settings?|env)\b/.test(p)) return 'config';
  return 'unknown';
}

function extractExports(text: string): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const exportDefault = /^export\s+default\s+(function|class|const|let|var|interface|type|enum)\s+(\w+)/.exec(line);
    if (exportDefault) {
      exports.push({ name: exportDefault[2], kind: exportDefault[1] as ExportInfo['kind'], line: lineNum });
      continue;
    }
    if (/^export\s+default\s/.test(line)) {
      exports.push({ name: 'default', kind: 'default', line: lineNum });
      continue;
    }

    const namedExport = /^export\s+(function|class|interface|type|const|let|var|enum)\s+(\w+)/.exec(line);
    if (namedExport) {
      exports.push({ name: namedExport[2], kind: namedExport[1] as ExportInfo['kind'], line: lineNum });
      continue;
    }

    const reExport = /^export\s+\{([^}]+)\}/.exec(line);
    if (reExport) {
      const names = reExport[1].split(',').map((n) => {
        const parts = n.trim().split(/\s+as\s+/);
        return (parts[1] ?? parts[0]).trim();
      }).filter(Boolean);
      for (const name of names) {
        if (name) exports.push({ name, kind: 'const', line: lineNum });
      }
      continue;
    }

    const starExport = /^export\s+\*\s+from\s+['"]([^'"]+)['"]/.exec(line);
    if (starExport) {
      exports.push({ name: '*', kind: 'const', line: lineNum });
    }
  }
  return exports;
}

function extractImports(text: string, filePath: string): Array<{ specifier: string; resolved: string; names: string[]; line: number }> {
  const imports: Array<{ specifier: string; resolved: string; names: string[]; line: number }> = [];
  const lines = text.split('\n');
  const importRe = /^(?:import|export)\s+(?:(?: type )?\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))?\s*(?:,\s*(?:\{([^}]*)\}|(\w+)))?\s*from\s*['"]([^'"]+)['"]/;
  const sideEffectRe = /^import\s+['"]([^'"]+)['"]/;
  const dynamicImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const m = importRe.exec(line);
    if (m) {
      const spec = m[6];
      if (!spec || !spec.startsWith('.')) continue;
      const names: string[] = [];
      const block1 = m[1] || m[4];
      if (block1) names.push(...block1.split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
      if (m[2]) names.push(m[2].trim());
      if (m[3] || m[5]) names.push((m[3] || m[5]).trim());
      imports.push({ specifier: spec, resolved: resolveRelative(filePath, spec), names, line: lineNum });
      continue;
    }

    const se = sideEffectRe.exec(line);
    if (se && se[1].startsWith('.')) {
      imports.push({ specifier: se[1], resolved: resolveRelative(filePath, se[1]), names: [], line: lineNum });
    }
  }

  for (const re of [dynamicImportRe, requireRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1].startsWith('.')) {
        imports.push({ specifier: m[1], resolved: resolveRelative(filePath, m[1]), names: [], line: 0 });
      }
    }
  }

  return imports;
}

function resolveRelative(fromFile: string, spec: string): string {
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const parts = (dir ? dir + '/' + spec : spec).split('/');
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p !== '.') resolved.push(p);
  }
  let r = resolved.join('/');
  if (!r.includes('.')) {
    r += '.ts';
  }
  return r;
}

function extractCallEdges(
  text: string,
  filePath: string,
  exportedNames: Map<string, string>,
): Array<{ to: string; callSite: string; line: number }> {
  const edges: Array<{ to: string; callSite: string; line: number }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [name, originFile] of exportedNames) {
      if (originFile === filePath) continue;
      const re = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, 'g');
      if (re.test(line)) {
        edges.push({ to: originFile, callSite: name, line: i + 1 });
      }
    }
  }
  return edges;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/**
 * Build or incrementally update the structural graph.
 * Full build: parse all files. Incremental: only re-parse changed files.
 */
export async function buildStructuralGraph(full = false): Promise<StructuralGraph> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return { files: [], imports: [], calls: [], entrypoints: [], builtAt: new Date().toISOString(), version: 0 };

  const prevGraph = full ? undefined : await loadStructuralGraph();
  const prevVersion = full ? undefined : await loadVersion();

  const fileUris = await vscode.workspace.findFiles(SUPPORTED_EXTS, EXCLUDE, MAX_FILES);
  const filePaths = fileUris.map((u) => vscode.workspace.asRelativePath(u));

  const currentHashes: Record<string, string> = {};
  const fileTexts: Record<string, string> = {};
  for (const uri of fileUris) {
    const rel = vscode.workspace.asRelativePath(uri);
    const text = await readText(uri);
    if (text != null) {
      currentHashes[rel] = contentHash(text);
      fileTexts[rel] = text;
    }
  }

  const wsHash = computeWorkspaceHash(filePaths);
  const changes = detectChanges(filePaths, currentHashes, prevVersion);

  const needsReparse = full ? filePaths : [...changes.added, ...changes.modified];
  const keptFiles = full ? [] : (prevGraph?.files.filter((f) => !changes.removed.includes(f.path) && !needsReparse.includes(f.path)) ?? []);

  const parsedNodes: FileNode[] = [];
  const parsedImports: ImportEdge[] = [];

  for (const filePath of needsReparse) {
    const text = fileTexts[filePath];
    if (!text) continue;
    const exports = extractExports(text);
    const imports = extractImports(text, filePath);
    const layer = inferLayer(filePath);
    parsedNodes.push({
      path: filePath,
      hash: currentHashes[filePath] ?? '',
      exports,
      layer,
      isEntrypoint: false,
    });
    for (const imp of imports) {
      parsedImports.push({ from: filePath, to: imp.resolved, specifiers: imp.names, line: imp.line });
    }
  }

  const allFiles = [...keptFiles, ...parsedNodes];
  const allImports = [
    ...(prevGraph?.imports.filter((e) => !needsReparse.includes(e.from) && !changes.removed.includes(e.from)) ?? []),
    ...parsedImports,
  ].filter((e) => !changes.removed.includes(e.to));

  const exportedNames = new Map<string, string>();
  for (const f of allFiles) {
    for (const exp of f.exports) {
      if (exp.name !== '*' && exp.name !== 'default') {
        exportedNames.set(exp.name, f.path);
      }
    }
  }

  const callEdges: CallEdge[] = [];
  const filesForCallScan = full ? filePaths : needsReparse;
  for (const filePath of filesForCallScan) {
    const text = fileTexts[filePath];
    if (!text) continue;
    const calls = extractCallEdges(text, filePath, exportedNames);
    for (const c of calls) {
      callEdges.push({ from: filePath, to: c.to, callSite: c.callSite, line: c.line });
    }
  }

  const importGraph = new Map<string, Set<string>>();
  for (const f of allFiles) importGraph.set(f.path, new Set<string>());
  for (const e of allImports) {
    const set = importGraph.get(e.from);
    if (set) set.add(e.to);
  }

  const entrypoints = detectEntrypoints(filePaths, importGraph);
  const entrypointSet = new Set(entrypoints.map((e) => e.file));
  for (const node of allFiles) {
    if (entrypointSet.has(node.path)) {
      node.isEntrypoint = true;
      node.entrypointReason = entrypoints.find((e) => e.file === node.path)?.reason;
    }
  }

  const graph: StructuralGraph = {
    files: allFiles,
    imports: allImports,
    calls: callEdges,
    entrypoints,
    builtAt: new Date().toISOString(),
    version: (prevGraph?.version ?? 0) + 1,
  };

  await saveStructuralGraph(graph);
  await saveVersion({
    workspaceHash: wsHash,
    fileHashes: currentHashes,
    structuralVersion: graph.version,
    semanticVersion: prevVersion?.semanticVersion ?? 0,
    lastBuiltAt: graph.builtAt,
  });

  return graph;
}

/**
 * Incrementally update one file in the graph (called on file save).
 */
export async function updateFileInGraph(uri: vscode.Uri): Promise<void> {
  const graph = await loadStructuralGraph();
  if (!graph) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;

  const rel = vscode.workspace.asRelativePath(uri);
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return;

  const text = await readText(uri);
  if (text == null) return;

  const hash = contentHash(text);
  const existingIdx = graph.files.findIndex((f) => f.path === rel);
  const existing = existingIdx >= 0 ? graph.files[existingIdx] : undefined;
  if (existing && existing.hash === hash) return;

  const exports = extractExports(text);
  const layer = inferLayer(rel);
  const node: FileNode = { path: rel, hash, exports, layer, isEntrypoint: existing?.isEntrypoint ?? false, entrypointReason: existing?.entrypointReason };

  if (existingIdx >= 0) graph.files[existingIdx] = node;
  else graph.files.push(node);

  graph.imports = graph.imports.filter((e) => e.from !== rel);
  const imports = extractImports(text, rel);
  for (const imp of imports) {
    graph.imports.push({ from: rel, to: imp.resolved, specifiers: imp.names, line: imp.line });
  }

  graph.calls = graph.calls.filter((e) => e.from !== rel);
  const exportedNames = new Map<string, string>();
  for (const f of graph.files) {
    for (const exp of f.exports) {
      if (exp.name !== '*' && exp.name !== 'default') exportedNames.set(exp.name, f.path);
    }
  }
  const calls = extractCallEdges(text, rel, exportedNames);
  for (const c of calls) {
    graph.calls.push({ from: rel, to: c.to, callSite: c.callSite, line: c.line });
  }

  graph.version++;
  graph.builtAt = new Date().toISOString();
  await saveStructuralGraph(graph);

  const version = await loadVersion();
  if (version) {
    version.fileHashes[rel] = hash;
    version.structuralVersion = graph.version;
    version.lastBuiltAt = graph.builtAt;
    await saveVersion(version);
  }
}

/**
 * Compact summary for system prompt injection.
 */
export function graphSummary(graph: StructuralGraph): string {
  const lines: string[] = [];
  const entrypoints = graph.files.filter((f) => f.isEntrypoint);
  if (entrypoints.length) {
    lines.push(`Entrypoints: ${entrypoints.map((e) => e.path).join(', ')}`);
  }

  const byLayer: Record<string, string[]> = {};
  for (const f of graph.files) {
    if (!byLayer[f.layer]) byLayer[f.layer] = [];
    byLayer[f.layer].push(f.path);
  }
  for (const [layer, files] of Object.entries(byLayer)) {
    if (layer === 'unknown' || layer === 'config') continue;
    const display = files.slice(0, 6).join(', ');
    const extra = files.length > 6 ? ` (+${files.length - 6} more)` : '';
    lines.push(`${layer}: ${display}${extra}`);
  }

  const importCount = graph.imports.length;
  const callCount = graph.calls.length;
  lines.push(`Files: ${graph.files.length}, Imports: ${importCount}, Call edges: ${callCount}`);

  return lines.join('\n');
}

/**
 * Get symbol graph: who imports a file, what does a file import.
 */
export function symbolGraph(graph: StructuralGraph, targetFile: string): {
  file: FileNode | undefined;
  importedBy: string[];
  imports: string[];
  calledBy: Array<{ from: string; callSite: string }>;
  calls: Array<{ to: string; callSite: string }>;
} {
  const file = graph.files.find((f) => f.path === targetFile);
  const importedBy = graph.imports.filter((e) => e.to === targetFile).map((e) => e.from);
  const imports = graph.imports.filter((e) => e.from === targetFile).map((e) => e.to);
  const calledBy = graph.calls.filter((e) => e.to === targetFile).map((e) => ({ from: e.from, callSite: e.callSite }));
  const calls = graph.calls.filter((e) => e.from === targetFile).map((e) => ({ to: e.to, callSite: e.callSite }));
  return { file, importedBy, imports, calledBy, calls };
}

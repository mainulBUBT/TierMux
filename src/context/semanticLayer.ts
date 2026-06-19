import * as vscode from 'vscode';
import { loadVersion, saveVersion } from './graphVersion';
import type { StructuralGraph, FileNode, LayerTag } from './structuralGraph';

const GRAPH_DIR = '.tiermux/graph';
const SEMANTIC_FILE = 'semantic.json';
const MAX_BATCH = 10;
const MIN_LINES_FOR_SUMMARY = 30;

export interface FileSemantic {
  path: string;
  contentHash: string;
  purpose: string;
  role: string;
  tags: string[];
}

export interface SemanticLayer {
  files: FileSemantic[];
  builtAt: string;
  version: number;
}

interface SummaryCache {
  entries: Record<string, string>;
}

function graphDirUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, GRAPH_DIR) : undefined;
}

function semanticUri(): vscode.Uri | undefined {
  const dir = graphDirUri();
  return dir ? vscode.Uri.joinPath(dir, SEMANTIC_FILE) : undefined;
}

function summaryCacheUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, '.tiermux/cache/file-summaries.json') : undefined;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
  try { await vscode.workspace.fs.createDirectory(uri); } catch { /* exists */ }
}

export async function loadSemanticLayer(): Promise<SemanticLayer | undefined> {
  const uri = semanticUri();
  if (!uri) return undefined;
  const text = await readText(uri);
  if (!text) return undefined;
  try { return JSON.parse(text) as SemanticLayer; } catch { return undefined; }
}

async function saveSemanticLayer(layer: SemanticLayer): Promise<void> {
  const dir = graphDirUri();
  const uri = semanticUri();
  if (!dir || !uri) return;
  await ensureDir(dir);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(layer)));
}

export async function loadSummaryCache(): Promise<SummaryCache> {
  const uri = summaryCacheUri();
  if (!uri) return { entries: {} };
  const text = await readText(uri);
  if (!text) return { entries: {} };
  try { return JSON.parse(text) as SummaryCache; } catch { return { entries: {} }; }
}

async function saveSummaryCache(cache: SummaryCache): Promise<void> {
  const uri = summaryCacheUri();
  if (!uri) return;
  await ensureDir(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(cache)));
}

function inferRole(layer: LayerTag, filePath: string): string {
  const roles: Record<LayerTag, string> = {
    api: 'API endpoint / route handler',
    service: 'Business logic / domain service',
    data: 'Data model / persistence layer',
    ui: 'User interface component',
    utility: 'Shared utility / helper',
    test: 'Test file',
    config: 'Configuration',
    unknown: 'Unclassified module',
  };
  const base = roles[layer];
  const fileName = filePath.split('/').pop() ?? filePath;
  return `${base} (${fileName})`;
}

function inferTags(filePath: string, exports: FileNode['exports']): string[] {
  const tags: string[] = [];
  const p = filePath.toLowerCase();
  if (/auth|login|session|token|jwt/i.test(p)) tags.push('auth');
  if (/error|exception|handler|catch/i.test(p)) tags.push('error-handling');
  if (/middleware|intercept|filter|guard/i.test(p)) tags.push('middleware');
  if (/cache|redis|memo/i.test(p)) tags.push('caching');
  if (/log|telemetry|trace|metric/i.test(p)) tags.push('observability');
  if (/config|env|setting/i.test(p)) tags.push('configuration');
  if (exports.some((e) => e.kind === 'class')) tags.push('has-class');
  if (exports.some((e) => e.kind === 'interface' || e.kind === 'type')) tags.push('has-types');
  return tags;
}

/**
 * Batch summarize files using a single LLM call.
 * Returns the summary text for the batch, which callers split into per-file entries.
 */
export function buildBatchSummaryPrompt(files: Array<{ path: string; firstLines: string }>): string {
  const entries = files.map((f, i) => `### File ${i + 1}: ${f.path}\n${f.firstLines}`).join('\n\n');
  return `For each file below, write a one-line purpose (max 15 words). Output ONLY a JSON array of strings, one per file, in order.\n\n${entries}`;
}

export function parseBatchSummaryResponse(response: string, fileCount: number): string[] {
  const trimmed = response.trim();
  const arrMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      if (Array.isArray(arr)) return arr.map((s) => String(s).trim()).slice(0, fileCount);
    } catch { /* fall through */ }
  }
  const lines = trimmed.split('\n').map((l) => l.replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  return lines.slice(0, fileCount);
}

/**
 * Build or update the semantic layer. Uses cached summaries where available,
 * batches new files for LLM summarization.
 */
export async function buildSemanticLayer(
  graph: StructuralGraph,
  summarizeBatch?: (prompt: string) => Promise<string>,
): Promise<SemanticLayer> {
  const prev = await loadSemanticLayer();
  const cache = await loadSummaryCache();

  const pending: Array<{ node: FileNode; text: string }> = [];
  const results: FileSemantic[] = [];

  for (const node of graph.files) {
    const existing = prev?.files.find((f) => f.path === node.path);
    if (existing && existing.contentHash === node.hash) {
      results.push(existing);
      continue;
    }

    const cached = cache.entries[node.hash];
    if (cached) {
      results.push({
        path: node.path,
        contentHash: node.hash,
        purpose: cached,
        role: inferRole(node.layer, node.path),
        tags: inferTags(node.path, node.exports),
      });
      continue;
    }

    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) continue;
      const uri = vscode.Uri.joinPath(root, node.path);
      const text = await readText(uri);
      if (!text) continue;
      const lines = text.split('\n');
      if (lines.length < MIN_LINES_FOR_SUMMARY) {
        const purpose = `Small ${node.layer} file (${lines.length} lines)`;
        cache.entries[node.hash] = purpose;
        results.push({ path: node.path, contentHash: node.hash, purpose, role: inferRole(node.layer, node.path), tags: inferTags(node.path, node.exports) });
        continue;
      }
      pending.push({ node, text: lines.slice(0, 40).join('\n') });
    } catch { /* skip */ }
  }

  if (pending.length > 0 && summarizeBatch) {
    for (let i = 0; i < pending.length; i += MAX_BATCH) {
      const batch = pending.slice(i, i + MAX_BATCH);
      const prompt = buildBatchSummaryPrompt(batch.map((b) => ({ path: b.node.path, firstLines: b.text })));
      try {
        const response = await summarizeBatch(prompt);
        const summaries = parseBatchSummaryResponse(response, batch.length);
        for (let j = 0; j < batch.length; j++) {
          const purpose = summaries[j] || `${batch[j].node.layer} module`;
          cache.entries[batch[j].node.hash] = purpose;
          results.push({
            path: batch[j].node.path,
            contentHash: batch[j].node.hash,
            purpose,
            role: inferRole(batch[j].node.layer, batch[j].node.path),
            tags: inferTags(batch[j].node.path, batch[j].node.exports),
          });
        }
      } catch {
        for (const b of batch) {
          const purpose = `${b.node.layer} module (summary unavailable)`;
          results.push({ path: b.node.path, contentHash: b.node.hash, purpose, role: inferRole(b.node.layer, b.node.path), tags: inferTags(b.node.path, b.node.exports) });
        }
      }
    }
  } else if (pending.length > 0) {
    for (const b of pending) {
      const purpose = `${b.node.layer} module`;
      cache.entries[b.node.hash] = purpose;
      results.push({ path: b.node.path, contentHash: b.node.hash, purpose, role: inferRole(b.node.layer, b.node.path), tags: inferTags(b.node.path, b.node.exports) });
    }
  }

  await saveSummaryCache(cache);

  const layer: SemanticLayer = {
    files: results,
    builtAt: new Date().toISOString(),
    version: (prev?.version ?? 0) + 1,
  };
  await saveSemanticLayer(layer);

  const version = await loadVersion();
  if (version) {
    version.semanticVersion = layer.version;
    await saveVersion(version);
  }

  return layer;
}

/**
 * Compact semantic summary for system prompt injection.
 */
export function semanticSummary(layer: SemanticLayer): string {
  const lines: string[] = [];
  const byTag: Record<string, string[]> = {};
  for (const f of layer.files) {
    for (const tag of f.tags) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(f.path);
    }
  }
  if (Object.keys(byTag).length > 0) {
    for (const [tag, files] of Object.entries(byTag).slice(0, 8)) {
      lines.push(`[${tag}] ${files.slice(0, 4).join(', ')}`);
    }
  }
  const purposeful = layer.files.filter((f) => f.purpose && !f.purpose.endsWith('(summary unavailable)'));
  if (purposeful.length > 0) {
    lines.push(`Key files:`);
    for (const f of purposeful.slice(0, 10)) {
      lines.push(`  ${f.path}: ${f.purpose}`);
    }
  }
  return lines.join('\n');
}

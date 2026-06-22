// Context Compression Layer.
//
// Problem: raw pre-research injects 1500–4000 chars of grep/symbol/hop lines.
// The model reads them linearly but lacks a quick mental model: "what are the key files?
// what is the architecture flow? where is the risk?"
//
// Solution: synthesise a compact "Codebase Understanding" block from the structured
// data collected during research — placed BEFORE the raw detail sections.
// The model reads the summary first, then uses the details for confirmation.
//
// All extraction is rule-based (zero LLM calls, zero latency).
import { inferLayer } from './structuralGraph';

export interface FileHit {
  file: string;
  layer: ReturnType<typeof inferLayer>;
  line?: number;
}

export interface SymbolHit {
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface ImportEdge {
  from: string;
  to: string;
}

export interface ResearchFacts {
  symbols: SymbolHit[];
  fileHits: FileHit[];
  importEdges: ImportEdge[];
  webTitles: string[];
  diagErrors: number;
  searchTerms: string[];
}

/**
 * Build a compact "## Codebase Understanding" markdown block.
 * Returns '' when there isn't enough data to say anything meaningful.
 */
export function compressToUnderstandingBlock(facts: ResearchFacts): string {
  const { symbols, fileHits, importEdges, webTitles, diagErrors, searchTerms } = facts;

  if (symbols.length === 0 && fileHits.length === 0) return '';

  const lines: string[] = ['## Codebase Understanding\n'];

  // 1. Task scope — symbols and terms found.
  const scopeNames = [
    ...symbols.slice(0, 5).map((s) => `\`${s.name}\``),
    ...searchTerms.filter((t) => !symbols.some((s) => s.name.toLowerCase() === t.toLowerCase())).slice(0, 2).map((t) => `\`${t}\``),
  ].filter(Boolean);
  if (scopeNames.length) lines.push(`**Scope:** ${scopeNames.join(', ')}`);

  // 2. Architecture flow — from import edges or layer ordering.
  const flowStr = buildFlowString(fileHits, importEdges);
  if (flowStr) lines.push(`**Architecture flow:** ${flowStr}`);

  // 3. Critical files — deduplicated, sorted by layer priority.
  const LAYER_PRIORITY: Record<string, number> = { api: 0, service: 1, data: 2, ui: 3, utility: 4, config: 5, test: 6, unknown: 7 };
  const uniqueFiles = deduplicateFileHits(fileHits);
  const sorted = uniqueFiles.sort((a, b) => (LAYER_PRIORITY[a.layer] ?? 7) - (LAYER_PRIORITY[b.layer] ?? 7));
  if (sorted.length > 0) {
    lines.push('**Critical files:**');
    for (const f of sorted.slice(0, 6)) {
      const lineRef = f.line ? `:${f.line}` : '';
      lines.push(`  - \`${f.file}${lineRef}\` _(${f.layer})_`);
    }
  }

  // 4. Risk areas — service + data layer (business logic, DB queries).
  const riskFiles = sorted.filter((f) => f.layer === 'service' || f.layer === 'data');
  if (riskFiles.length > 0) {
    const riskList = riskFiles.slice(0, 3).map((f) => `\`${f.file}\``).join(', ');
    const riskReason = riskFiles.some((f) => f.layer === 'data') ? 'DB queries + business logic' : 'business logic';
    lines.push(`**Risk areas:** ${riskList} — ${riskReason}`);
  }

  // 5. Active diagnostics warning.
  if (diagErrors > 0) lines.push(`**Active errors:** ${diagErrors} diagnostic error${diagErrors > 1 ? 's' : ''} in workspace`);

  // 6. Web context summary (first title only — model can read details below).
  if (webTitles.length > 0) lines.push(`**Web:** ${webTitles[0]}`);

  return lines.join('\n');
}

/** Build an architecture flow string from import edges + layer ordering. */
function buildFlowString(files: FileHit[], edges: ImportEdge[]): string {
  // Try import edge chain first (most precise).
  if (edges.length > 0) {
    const uniqueFiles = deduplicateFileHits(files);
    // Find a chain: start from api layer, follow edges up to 3 hops.
    const apiFile = uniqueFiles.find((f) => f.layer === 'api');
    if (apiFile) {
      const chain: string[] = [basename(apiFile.file)];
      let current = apiFile.file;
      for (let hop = 0; hop < 3; hop++) {
        const next = edges.find((e) => e.from === current);
        if (!next) break;
        chain.push(basename(next.to));
        current = next.to;
      }
      if (chain.length > 1) return chain.join(' → ');
    }
    // Fall back: just show all edges as A → B.
    const edgeLines = edges.slice(0, 3).map((e) => `${basename(e.from)} → ${basename(e.to)}`);
    if (edgeLines.length) return edgeLines.join(', ');
  }

  // If no edges, infer flow from layer distribution.
  const layerOrder = ['api', 'service', 'data', 'config'] as const;
  const presentLayers = layerOrder.filter((l) => files.some((f) => f.layer === l));
  if (presentLayers.length > 1) {
    const labels: Record<string, string> = { api: 'Controller', service: 'Service', data: 'Repository', config: 'Config' };
    return presentLayers.map((l) => {
      const file = files.find((f) => f.layer === l);
      return file ? basename(file.file) : labels[l];
    }).join(' → ');
  }
  return '';
}

function deduplicateFileHits(files: FileHit[]): FileHit[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    if (seen.has(f.file)) return false;
    seen.add(f.file);
    return true;
  });
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

// ---- Compact XML-style context block (token-efficient alternative) ----
//
// Used when the execution planner has high confidence (≥ 0.7) — the plan already
// lists every file with its path, so raw grep output is redundant. This compact
// block replaces the full Understanding section + raw details, saving ~600-900 tokens
// per request on routine feature/fix tasks.
//
// Format example (< 120 chars total):
//   <ctx flow="DeliveryController→DeliveryService→DeliveryRepository">
//   api:DeliveryController.php:89  service:DeliveryService.php:42  data:DeliveryRepository.php
//   risk:service,data  diag:0  web:Laravel delivery fee calculation
//   </ctx>
export function compactContextBlock(facts: ResearchFacts): string {
  if (facts.fileHits.length === 0 && facts.symbols.length === 0) return '';

  const LAYER_PRIORITY: Record<string, number> = { api: 0, service: 1, data: 2, ui: 3, utility: 4, config: 5, test: 6, unknown: 7 };
  const unique = deduplicateFileHits([
    ...facts.symbols.map((s) => ({ file: s.file, layer: inferLayer(s.file), line: s.line })),
    ...facts.fileHits,
  ]).sort((a, b) => (LAYER_PRIORITY[a.layer] ?? 7) - (LAYER_PRIORITY[b.layer] ?? 7));

  const flow = buildFlowString(unique, facts.importEdges);
  const flowAttr = flow ? ` flow="${flow}"` : '';

  // One entry per file: "layer:file[:line]"
  const fileParts = unique.slice(0, 6).map((f) => {
    const lineRef = f.line ? `:${f.line}` : '';
    return `${f.layer}:${f.file}${lineRef}`;
  });

  const riskLayers = unique.filter((f) => f.layer === 'service' || f.layer === 'data').map((f) => f.layer);
  const riskStr = riskLayers.length ? `  risk:${[...new Set(riskLayers)].join(',')}` : '';
  const diagStr = facts.diagErrors > 0 ? `  diag:${facts.diagErrors}` : '';
  const webStr = facts.webTitles.length ? `  web:${facts.webTitles[0].slice(0, 60)}` : '';

  return `<ctx${flowAttr}>\n${fileParts.join('  ')}\n${riskStr}${diagStr}${webStr}\n</ctx>`;
}

// ---- Section parsers — extract ResearchFacts from formatted research sections ----

/** Extract structured facts from the sections produced by runResearchPipeline. */
export function parseResearchFacts(sections: string[], searchTerms: string[]): ResearchFacts {
  const facts: ResearchFacts = {
    symbols: [],
    fileHits: [],
    importEdges: [],
    webTitles: [],
    diagErrors: 0,
    searchTerms,
  };

  for (const sec of sections) {
    if (sec.startsWith('### Symbol index hits')) {
      // Lines like: `- \`name\` kind → file:line`
      for (const m of sec.matchAll(/- `(\w+)` (\w+) → ([\w./\\-]+):(\d+)/g)) {
        const file = m[3]; const line = parseInt(m[4], 10);
        facts.symbols.push({ name: m[1], kind: m[2], file, line });
        facts.fileHits.push({ file, layer: inferLayer(file), line });
      }
    } else if (sec.startsWith('### Grep results') || sec.startsWith('### Semantic matches')) {
      // Lines like: `- **path/to/file.ts**: L42: ...`
      for (const m of sec.matchAll(/\*\*([\w./\\-]+\.[a-zA-Z]{1,5})\*\*/g)) {
        facts.fileHits.push({ file: m[1], layer: inferLayer(m[1]) });
      }
      // Also capture line refs from semantic code blocks: `// file:line`
      for (const m of sec.matchAll(/\/\/ ([\w./\\-]+\.[a-zA-Z]{1,5}):(\d+)/g)) {
        facts.fileHits.push({ file: m[1], layer: inferLayer(m[1]), line: parseInt(m[2], 10) });
      }
    } else if (sec.startsWith('### Import chain')) {
      // Lines like: `- \`from.php\` → \`to1.php\`, \`to2.php\``
      for (const m of sec.matchAll(/`([\w./\\-]+\.[a-zA-Z]{1,5})`\s*→\s*(.+)/g)) {
        const from = m[1];
        for (const dest of m[2].matchAll(/`([\w./\\-]+\.[a-zA-Z]{1,5})`/g)) {
          facts.importEdges.push({ from, to: dest[1] });
          facts.fileHits.push({ file: dest[1], layer: inferLayer(dest[1]) });
        }
      }
    } else if (sec.startsWith('### Web results')) {
      for (const m of sec.matchAll(/\*\*(.+?)\*\*/g)) {
        facts.webTitles.push(m[1]);
        break;
      }
    } else if (sec.startsWith('### Current diagnostics')) {
      facts.diagErrors = (sec.match(/L\d+/g) ?? []).length;
    }
  }

  return facts;
}

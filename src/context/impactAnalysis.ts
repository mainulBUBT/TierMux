import type { StructuralGraph, LayerTag } from './structuralGraph';
import type { SemanticLayer } from './semanticLayer';

export interface ImpactResult {
  file: string;
  reason: string;
  distance: number;
  layer: LayerTag;
}

export interface ImpactAnalysis {
  changedFiles: string[];
  impacted: ImpactResult[];
  byLayer: Record<string, ImpactResult[]>;
  summary: string;
}

/**
 * Graph-first impact analysis. LLM is optional — the graph does the real work.
 * 1. Traverse import graph (transitive closure from changed files).
 * 2. Check call edges for additional reachability.
 * 3. Group by architectural layer.
 * 4. Return ranked results with distance from change origin.
 */
export function analyzeImpact(
  graph: StructuralGraph,
  changedFiles: string[],
  semantic?: SemanticLayer,
): ImpactAnalysis {
  const changed = new Set(changedFiles);
  const visited = new Map<string, number>();
  const queue: Array<{ file: string; distance: number }> = [];

  for (const f of changedFiles) {
    visited.set(f, 0);
    queue.push({ file: f, distance: 0 });
  }

  while (queue.length > 0) {
    const { file, distance } = queue.shift()!;
    for (const edge of graph.imports) {
      if (edge.to === file && !visited.has(edge.from)) {
        visited.set(edge.from, distance + 1);
        queue.push({ file: edge.from, distance: distance + 1 });
      }
    }
    for (const edge of graph.calls) {
      if (edge.to === file && !visited.has(edge.from)) {
        visited.set(edge.from, distance + 1);
        queue.push({ file: edge.from, distance: distance + 1 });
      }
    }
  }

  const impacted: ImpactResult[] = [];
  for (const [file, distance] of visited) {
    if (changed.has(file)) continue;
    const node = graph.files.find((f) => f.path === file);
    impacted.push({
      file,
      reason: distance === 1 ? 'directly imports/uses changed file' : `${distance} steps from change`,
      distance,
      layer: node?.layer ?? 'unknown',
    });
  }

  impacted.sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));

  const byLayer: Record<string, ImpactResult[]> = {};
  for (const r of impacted) {
    if (!byLayer[r.layer]) byLayer[r.layer] = [];
    byLayer[r.layer].push(r);
  }

  const summary = buildImpactSummary(changedFiles, impacted, byLayer, semantic);

  return { changedFiles, impacted, byLayer, summary };
}

function buildImpactSummary(
  changedFiles: string[],
  impacted: ImpactResult[],
  byLayer: Record<string, ImpactResult[]>,
  semantic?: SemanticLayer,
): string {
  const lines: string[] = [];
  lines.push(`Changed: ${changedFiles.join(', ')}`);
  lines.push(`Impacted: ${impacted.length} file(s)`);

  for (const [layer, results] of Object.entries(byLayer)) {
    const display = results.slice(0, 5).map((r) => {
      const sem = semantic?.files.find((f) => f.path === r.file);
      return sem?.purpose ? `${r.file} (${sem.purpose})` : r.file;
    });
    const extra = results.length > 5 ? ` +${results.length - 5} more` : '';
    lines.push(`  ${layer}: ${display.join(', ')}${extra}`);
  }

  return lines.join('\n');
}

/**
 * Compact impact summary for agent consumption (Markdown).
 */
export function impactMarkdown(analysis: ImpactAnalysis): string {
  const lines: string[] = [];
  lines.push(`## Impact Analysis`);
  lines.push(`**Changed files:** ${analysis.changedFiles.join(', ')}`);
  lines.push(`**Impacted files:** ${analysis.impacted.length}\n`);

  for (const [layer, results] of Object.entries(analysis.byLayer)) {
    lines.push(`### ${layer} (${results.length})`);
    for (const r of results.slice(0, 10)) {
      lines.push(`- \`${r.file}\` — ${r.reason}`);
    }
    if (results.length > 10) lines.push(`- ... +${results.length - 10} more`);
  }

  return lines.join('\n');
}

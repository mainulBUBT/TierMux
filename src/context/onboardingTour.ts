import type { StructuralGraph } from './structuralGraph';
import type { SemanticLayer } from './semanticLayer';

export interface TourStop {
  file: string;
  title: string;
  description: string;
  layer: string;
  order: number;
}

export interface OnboardingTour {
  stops: TourStop[];
  generatedAt: string;
}

function bfsDepth(graph: StructuralGraph, roots: string[]): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: Array<{ file: string; d: number }> = [];
  for (const r of roots) {
    depth.set(r, 0);
    queue.push({ file: r, d: 0 });
  }
  while (queue.length > 0) {
    const { file, d } = queue.shift()!;
    for (const edge of graph.imports) {
      if (edge.from === file && !depth.has(edge.to)) {
        depth.set(edge.to, d + 1);
        queue.push({ file: edge.to, d: d + 1 });
      }
    }
  }
  return depth;
}

/**
 * Build an onboarding tour from the structural graph.
 * Selects 4–6 key files ordered by dependency depth from entrypoints.
 */
export function buildTour(graph: StructuralGraph, semantic?: SemanticLayer): OnboardingTour {
  const roots = graph.files.filter((f) => f.isEntrypoint).map((f) => f.path);
  if (roots.length === 0 && graph.files.length > 0) {
    roots.push(graph.files[0].path);
  }

  const depth = bfsDepth(graph, roots);
  const candidates = [...depth.entries()]
    .filter(([file]) => {
      const node = graph.files.find((f) => f.path === file);
      return node && node.layer !== 'test' && node.layer !== 'config';
    })
    .sort((a, b) => a[1] - b[1]);

  const selected: string[] = [];
  const usedLayers = new Set<string>();
  const MAX_STOPS = 6;

  for (const [file] of candidates) {
    if (selected.length >= MAX_STOPS) break;
    const node = graph.files.find((f) => f.path === file);
    if (!node) continue;
    if (selected.length >= 3 && usedLayers.has(node.layer)) continue;
    selected.push(file);
    usedLayers.add(node.layer);
  }

  if (selected.length < 3) {
    for (const [file] of candidates) {
      if (selected.length >= 4) break;
      if (!selected.includes(file)) selected.push(file);
    }
  }

  const stops: TourStop[] = selected.map((file, i) => {
    const node = graph.files.find((f) => f.path === file);
    const sem = semantic?.files.find((f) => f.path === file);
    const importers = graph.imports.filter((e) => e.to === file).length;
    return {
      file,
      title: describeFile(file, node?.layer ?? 'unknown'),
      description: sem?.purpose ?? `Exports ${node?.exports.length ?? 0} symbols, imported by ${importers} files`,
      layer: node?.layer ?? 'unknown',
      order: i + 1,
    };
  });

  return { stops, generatedAt: new Date().toISOString() };
}

function describeFile(file: string, layer: string): string {
  const name = file.split('/').pop() ?? file;
  const base = name.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
  const readable = base
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `${readable} (${layer})`;
}

/**
 * Render the tour as Markdown for chat display.
 */
export function tourMarkdown(tour: OnboardingTour): string {
  const lines: string[] = [];
  lines.push('## Onboarding Tour\n');
  lines.push('Recommended reading order for understanding this codebase:\n');
  for (const stop of tour.stops) {
    lines.push(`### ${stop.order}. ${stop.title}`);
    lines.push(`\`${stop.file}\``);
    lines.push(`${stop.description}\n`);
  }
  return lines.join('\n');
}

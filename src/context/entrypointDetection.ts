const ENTRYPOINT_PATTERNS: Array<{ pattern: RegExp; confidence: number }> = [
  { pattern: /^(src\/)?(main|index|app|server|entry|boot|bootstrap)\.(ts|tsx|js|jsx|mjs)$/i, confidence: 1.0 },
  { pattern: /^(src\/)?(cli|bin)\.(ts|tsx|js|jsx|mjs)$/i, confidence: 0.9 },
  { pattern: /^(bin|cli)\/.*\.(ts|tsx|js|jsx|mjs)$/i, confidence: 0.9 },
  { pattern: /^(src\/)?routes?\.(ts|tsx|js|jsx)$/i, confidence: 0.8 },
  { pattern: /\/(routes?|router|api)\//i, confidence: 0.7 },
  { pattern: /\/(server|app)\.(ts|tsx|js|jsx)$/i, confidence: 0.8 },
  { pattern: /^(src\/)?extension\.(ts|tsx|js|jsx)$/i, confidence: 0.8 },
];

export interface EntrypointInfo {
  file: string;
  reason: string;
  confidence: number;
}

export function detectEntrypoints(
  files: string[],
  importGraph: Map<string, Set<string>>,
): EntrypointInfo[] {
  const results: EntrypointInfo[] = [];

  for (const file of files) {
    for (const { pattern, confidence } of ENTRYPOINT_PATTERNS) {
      if (pattern.test(file)) {
        results.push({ file, reason: `matches ${pattern.source}`, confidence });
        break;
      }
    }
  }

  const importedByAnyone = new Set<string>();
  for (const importers of importGraph.values()) {
    for (const imp of importers) importedByAnyone.add(imp);
  }

  for (const file of files) {
    if (!importedByAnyone.has(file) && !results.some((r) => r.file === file)) {
      const ext = file.split('.').pop()?.toLowerCase();
      if (ext && ['ts', 'tsx', 'js', 'jsx', 'mjs'].includes(ext)) {
        results.push({ file, reason: 'imported by nothing (leaf consumer)', confidence: 0.5 });
      }
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

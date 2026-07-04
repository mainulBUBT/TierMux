/* Parse docs/BENCHMARK_QUERIES.md into BenchQuery[].
 *
 * Format (5 categories, 50 queries):
 *   - Categories 1–4 (Explain / Bug Fix / Feature / Refactor): markdown table
 *       | # | Query | Expected retrieval |
 *   - Category 5 (Follow-up): 4 chains under ### Chain X headers, table
 *       | # | Query |
 *
 * v1 treats every query as INDEPENDENT — chain grouping is parsed into the
 * `followup` category but no context is carried between steps. Chain
 * continuity is a v2 concern.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BenchQuery, Category } from './types';

const CATEGORY_BY_HEADER: Record<string, Category> = {
  'category 1: explain': 'explain',
  'category 2: bug fix': 'bugfix',
  'category 3: feature': 'feature',
  'category 4: refactor': 'refactor',
  'category 5: follow-up': 'followup',
  'category 5: follow-up / continuation': 'followup',
};

/** Parse the dataset at the given absolute path. Throws if it can't find 50 queries. */
export function parseDataset(file: string): BenchQuery[] {
  const md = fs.readFileSync(file, 'utf8');
  const lines = md.split(/\r?\n/);
  const out: BenchQuery[] = [];

  // Current category, tracked across the whole file. Set when we cross a
  // "## Category N: …" header. Chain headers (### Chain …) inside category 5
  // don't change it — they all roll up to `followup`.
  let category: Category | null = null;

  for (const raw of lines) {
    const line = raw.trim();

    // Category header: "## Category 1: Explain (10 queries)"
    const catMatch = /^##\s+(category\s+\d+:\s+[^()]+?)(?:\s*\()/i.exec(line);
    if (catMatch) {
      const key = catMatch[1].trim().toLowerCase();
      category = CATEGORY_BY_HEADER[key] ?? null;
      continue;
    }

    // Stop at the Scoring Sheet (## Scoring Sheet) — its rows reuse ids like
    // E1/E2 with short labels and would otherwise produce duplicates.
    if (/^##\s+scoring\s+sheet/i.test(line)) break;

    if (!category) continue;

    // Table rows only. Skip separators (|---|---|) and headers (| # | …).
    if (!line.startsWith('|')) continue;
    if (/^\|\s*[-:|\s]+\|?\s*$/.test(line)) continue; // separator
    if (/^\|\s*#\s*\|/i.test(line)) continue;          // column header row

    // Split columns. Two shapes:
    //   | E1 | How does…? | ContributionService, … |
    //   | C1 | How does…? |
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;

    const id = cells[0];
    const query = cells[1];
    const expectedRetrieval = cells[2];

    // Must look like an id (letter + digits) and have non-empty query text.
    if (!/^[A-Z]\d+$/.test(id)) continue;
    if (!query) continue;

    out.push({
      id,
      category,
      query,
      ...(expectedRetrieval ? { expectedRetrieval } : {}),
    });
  }

  return out;
}

/** Parse and validate — returns the queries or throws a clear error. */
export function loadDataset(file: string): BenchQuery[] {
  const queries = parseDataset(file);
  if (queries.length === 0) {
    throw new Error(`No queries parsed from ${file}`);
  }
  // Ids must be unique.
  const ids = new Set<string>();
  for (const q of queries) {
    if (ids.has(q.id)) throw new Error(`Duplicate query id ${q.id} in dataset`);
    ids.add(q.id);
  }
  return queries;
}

if (require.main === module) {
  // npm scripts run from the project root, so cwd is the TierMux repo.
  const file = path.resolve(process.cwd(), 'docs/BENCHMARK_QUERIES.md');
  const queries = loadDataset(file);
  const byCat: Record<string, number> = {};
  for (const q of queries) byCat[q.category] = (byCat[q.category] ?? 0) + 1;
  console.log(`Parsed ${queries.length} queries:`);
  for (const [cat, n] of Object.entries(byCat)) console.log(`  ${cat}: ${n}`);
  console.log('\nFirst 3:');
  for (const q of queries.slice(0, 3)) console.log(`  ${q.id} [${q.category}]: ${q.query.slice(0, 60)}…`);
}

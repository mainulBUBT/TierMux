/* Load + validate a quality benchmark dataset (JSON).
 *
 * JSON, not the markdown tables docs/BENCHMARK_QUERIES.md uses, because retrieval scoring needs
 * machine-checkable ground truth: an "Expected retrieval" cell reading "[Core Service],
 * [Action Controller]" is a note to a human, not a path an assertion can match. Datasets are
 * per-project (ground truth is paths in THAT repo) — hence the required `project` field and the
 * check in runQuality.ts that it matches the workspace being benchmarked.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { QualityCategory, QualityDataset, QualityMode, QualityQuery } from './qualityTypes';

const CATEGORIES: QualityCategory[] = ['explain', 'bugfix', 'feature', 'refactor', 'followup'];

/** Explain questions are pure Q&A; the action categories run in plan mode so the model has to
 *  reach a concrete, file-level proposal — still read-only, so the bench never edits the repo. */
export function defaultMode(category: QualityCategory): QualityMode {
  return category === 'explain' ? 'ask' : 'plan';
}

function fail(file: string, msg: string): never {
  throw new Error(`${path.basename(file)}: ${msg}`);
}

export function loadQualityDataset(file: string): QualityDataset {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(file, `not readable as JSON — ${(e as Error).message}`);
  }
  const ds = raw as Partial<QualityDataset>;
  if (!ds || typeof ds !== 'object') fail(file, 'top level must be an object');
  if (typeof ds.project !== 'string' || !ds.project.trim()) {
    fail(file, 'missing "project" (the repo this ground truth was authored against)');
  }
  if (!Array.isArray(ds.queries) || ds.queries.length === 0) fail(file, 'missing/empty "queries"');

  const seen = new Set<string>();
  const queries: QualityQuery[] = ds.queries.map((q, i) => {
    const where = `queries[${i}]`;
    if (!q || typeof q !== 'object') fail(file, `${where} is not an object`);
    if (typeof q.id !== 'string' || !q.id) fail(file, `${where} missing "id"`);
    if (seen.has(q.id)) fail(file, `duplicate query id "${q.id}"`);
    seen.add(q.id);
    if (typeof q.query !== 'string' || !q.query.trim()) fail(file, `${q.id}: missing "query"`);
    if (!CATEGORIES.includes(q.category)) {
      fail(file, `${q.id}: category must be one of ${CATEGORIES.join(' | ')}`);
    }
    // Ground truth is what makes retrieval auto-scorable; a query without it would silently
    // score 1.0 for touching nothing, which is worse than no data at all.
    if (!Array.isArray(q.expectFiles) || q.expectFiles.length === 0) {
      fail(file, `${q.id}: "expectFiles" must list at least one path (retrieval ground truth)`);
    }
    if (q.mode && q.mode !== 'ask' && q.mode !== 'plan') {
      fail(file, `${q.id}: mode must be "ask" or "plan" (the bench is read-only)`);
    }
    return { ...q, mode: q.mode ?? defaultMode(q.category) };
  });

  return { project: ds.project, description: ds.description, queries };
}

/** Warn about ground-truth paths that don't exist in the workspace — the #1 way a dataset
 *  silently under-reports retrieval after a refactor moves a file. */
export function checkGroundTruth(dataset: QualityDataset, workspaceRoot: string): string[] {
  const problems: string[] = [];
  for (const q of dataset.queries) {
    for (const p of [...q.expectFiles, ...(q.expectAnyOf ?? [])]) {
      if (!fs.existsSync(path.join(workspaceRoot, p))) problems.push(`${q.id}: ${p}`);
    }
  }
  return problems;
}

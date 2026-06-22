// Pre-Execution Planner — runs BEFORE the first LLM call.
//
// Problem: without a plan, the model gropes forward: tool → guess → tool → guess.
// The order is random. Files get touched in the wrong sequence. Steps get repeated.
//
// Solution: given the compressed research facts, build a deterministic ordered
// execution plan. The model receives a numbered checklist with concrete file paths
// and a dependency-correct step order. It executes the list instead of navigating blind.
//
// All logic is rule-based — zero LLM calls, zero latency, zero rate-limit cost.
import type { ResearchFacts, FileHit } from './researchCompressor';
import type { InformationRoute } from '../router/informationRouter';
import { inferLayer } from './structuralGraph';

export type PlanMode = 'fast' | 'deep' | 'ask';
export type TaskType = 'feature' | 'fix' | 'refactor' | 'research' | 'unknown';

export interface PlannedStep {
  id: number;
  action: string;
  file: string;
  exists: boolean;
  layer: string;
}

export interface ExecutionPlan {
  taskType: TaskType;
  confidence: number;
  mode: PlanMode;
  steps: PlannedStep[];
  riskAreas: string[];
  missingInfoQuestions: string[];
}

// ---- Task-type detection (pure regex, no LLM) ----

const FEATURE_VERB = /\b(add|create|implement|build|scaffold|generate|introduce|support|enable)\b/i;
const FIX_VERB = /\b(fix|resolve|debug|repair|patch|correct|address)\b/i;
const REFACTOR_VERB = /\b(refactor|extract|rename|move|restructure|clean|rewrite|split|merge|migrate)\b/i;
const RESEARCH_VERB = /\b(find|show|explain|trace|understand|where|how|what|list|search|describe|analyse|analyze|review)\b/i;

function detectTaskType(text: string): TaskType {
  if (FIX_VERB.test(text)) return 'fix';
  if (REFACTOR_VERB.test(text)) return 'refactor';
  if (FEATURE_VERB.test(text)) return 'feature';
  if (RESEARCH_VERB.test(text)) return 'research';
  return 'unknown';
}

// ---- Step ordering: dependency-correct layer sequence ----

const LAYER_ACTION: Record<string, string> = {
  api: 'update_controller',
  service: 'update_service',
  data: 'update_model',
  ui: 'update_view',
  config: 'update_config',
  test: 'update_test',
  utility: 'update_utility',
  unknown: 'update_file',
};

// Finer-grained action from filename patterns (takes priority over layer-only).
function actionFromFile(file: string, taskType: TaskType): string {
  const f = file.replace(/\\/g, '/').toLowerCase();
  const base = f.split('/').pop() ?? f;

  if (/migrations?/.test(f)) return taskType === 'feature' ? 'create_migration' : 'update_migration';
  if (/repositor/.test(f) || /repo\./.test(base)) return 'update_repository';
  if (/controller/.test(f)) return 'update_controller';
  if (/service/.test(f)) return 'update_service';
  if (/model/.test(f) || /\bmodels?\b/.test(f)) return 'update_model';
  if (/request\./.test(base) || /requests?/.test(f)) return 'update_request';
  if (/test/.test(f) || /spec\./.test(base)) return 'update_test';
  if (/route/.test(f)) return 'update_route';
  if (/config/.test(f) || /settings/.test(f) || /env/.test(f)) return 'update_config';
  if (/view/.test(f) || /blade/.test(f) || /\.vue$/.test(base) || /\.jsx?$/.test(base) || /\.tsx?$/.test(base)) return 'update_view';

  return LAYER_ACTION[inferLayer(file)] ?? 'update_file';
}

// Priority determines execution ORDER (lower = earlier).
const ACTION_PRIORITY: Record<string, number> = {
  create_migration: 0,
  update_migration: 0,
  update_model: 1,
  update_repository: 2,
  update_service: 3,
  update_controller: 4,
  update_request: 5,
  update_route: 6,
  update_utility: 7,
  update_config: 8,
  update_view: 9,
  update_file: 10,
  update_test: 11,
  add_test: 12,
};

function stepPriority(action: string): number {
  return ACTION_PRIORITY[action] ?? 10;
}

// ---- Gap detection: suggest steps for missing architectural pieces ----

const NEEDS_MIGRATION = /\b(table|migration|column|field|schema|slot|booking|reservation|schedule|entry|record)\b/i;
const NEEDS_TEST = /\b(test|spec|coverage|unit|feature test|integration)\b/i;

function suggestGapSteps(
  existing: PlannedStep[],
  taskType: TaskType,
  text: string,
  facts: ResearchFacts,
): PlannedStep[] {
  if (taskType !== 'feature' && taskType !== 'fix') return [];

  const gaps: PlannedStep[] = [];
  const actions = new Set(existing.map((s) => s.action));

  // Suggest migration for new-data features.
  if (
    taskType === 'feature'
    && NEEDS_MIGRATION.test(text)
    && !actions.has('create_migration')
    && !actions.has('update_migration')
  ) {
    // Infer migration name from first search term.
    const term = (facts.searchTerms[0] ?? 'new').toLowerCase().replace(/\s+/g, '_');
    gaps.push({
      id: 0,
      action: 'create_migration',
      file: `database/migrations/create_${term}_table.php`,
      exists: false,
      layer: 'data',
    });
  }

  // Suggest test for feature/fix tasks.
  if (!actions.has('update_test') && !actions.has('add_test') && !NEEDS_TEST.test(text)) {
    const firstFile = existing[0]?.file ?? '';
    const testPath = firstFile
      ? firstFile.replace(/app\//, 'tests/Feature/').replace(/\.php$/, 'Test.php')
      : 'tests/Feature/FeatureTest.php';
    gaps.push({
      id: 0,
      action: 'add_test',
      file: testPath,
      exists: false,
      layer: 'test',
    });
  }

  return gaps;
}

// ---- Risk areas from layer + file patterns ----

function identifyRiskAreas(fileHits: FileHit[]): string[] {
  const risks: string[] = [];
  for (const f of fileHits) {
    if (f.layer === 'data') {
      risks.push(`\`${f.file}\` — DB queries / migration side-effects`);
    } else if (f.layer === 'service') {
      risks.push(`\`${f.file}\` — business logic overwrite risk`);
    }
    if (risks.length >= 3) break;
  }
  return risks;
}

// ---- Main entry point ----

/**
 * Build a deterministic execution plan from pre-researched facts.
 * Returns `null` when there isn't enough signal (e.g. pure research or web-only queries).
 */
export function buildExecutionPlan(
  facts: ResearchFacts,
  route: InformationRoute,
  latestText: string,
): ExecutionPlan | null {
  // Planner only activates for code tasks where we found something.
  if (!route.codeSearch) return null;
  if (facts.fileHits.length === 0 && facts.symbols.length === 0) return null;

  const taskType = detectTaskType(latestText);
  // Pure research queries don't need a step-by-step plan.
  if (taskType === 'research') return null;

  const confidence = route.confidence;
  const mode: PlanMode = confidence < 0.35 ? 'ask' : confidence < 0.7 ? 'deep' : 'fast';

  if (mode === 'ask') return null; // handled by confidence gate already

  // Build steps from discovered files (deduplicated).
  const seen = new Set<string>();
  const rawSteps: PlannedStep[] = [];
  let nextId = 1;

  // Merge symbol hits + file hits.
  const allFiles: FileHit[] = [
    ...facts.symbols.map((s) => ({ file: s.file, layer: inferLayer(s.file), line: s.line })),
    ...facts.fileHits,
  ];

  for (const f of allFiles) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    rawSteps.push({
      id: nextId++,
      action: actionFromFile(f.file, taskType),
      file: f.file,
      exists: true,
      layer: f.layer,
    });
  }

  // Add gap steps (migration, test).
  for (const g of suggestGapSteps(rawSteps, taskType, latestText, facts)) {
    if (!seen.has(g.file)) {
      seen.add(g.file);
      rawSteps.push(g);
    }
  }

  // Sort by dependency order.
  rawSteps.sort((a, b) => stepPriority(a.action) - stepPriority(b.action));

  // Renumber after sort.
  rawSteps.forEach((s, i) => { s.id = i + 1; });

  // Cap at 8 steps to avoid overwhelming the model.
  const steps = rawSteps.slice(0, 8);

  const riskAreas = identifyRiskAreas(facts.fileHits);

  // Missing info: flag when we have steps but no file found for a key layer.
  const missingInfoQuestions: string[] = [];
  if (mode === 'deep' && steps.length > 0) {
    const hasService = steps.some((s) => s.action === 'update_service');
    const hasController = steps.some((s) => s.action === 'update_controller');
    if (taskType === 'feature' && !hasService && !hasController) {
      missingInfoQuestions.push('Which service or controller owns this feature?');
    }
  }

  return { taskType, confidence, mode, steps, riskAreas, missingInfoQuestions };
}

/**
 * Compact XML-style plan — used when confidence ≥ 0.7 (fast-path).
 *
 * Token budget: ~40-70 tokens vs ~120-160 for the verbose format.
 *
 * Example output:
 *   <plan type="feature" conf="90">
 *   create_migration:database/migrations/create_slot.php[new]
 *   update_model:app/Models/Slot.php[new]
 *   update_service:app/Services/DeliveryService.php:42[exists]
 *   update_controller:app/Http/Controllers/DeliveryController.php:89[exists]
 *   risk:DeliveryService.php(logic),DeliveryRepository.php(db)
 *   </plan>
 */
export function formatExecutionPlan(plan: ExecutionPlan): string {
  const conf = Math.round(plan.confidence * 100);

  if (plan.steps.length === 0) return '';

  const stepLines = plan.steps.map((s) => {
    const lineRef = s.exists ? '' : '';  // line info already in file path when exists
    const status = s.exists ? '[exists]' : '[new]';
    return `${s.action}:${s.file}${lineRef}${status}`;
  });

  const riskStr = plan.riskAreas.length
    ? `risk:${plan.riskAreas.map((r) => r.replace(/`/g, '').replace(/ —.*$/, '')).join(',')}`
    : '';

  const askStr = plan.missingInfoQuestions.length
    ? `ask:${plan.missingInfoQuestions.join(' | ')}`
    : '';

  const body = [
    ...stepLines,
    riskStr,
    askStr,
  ].filter(Boolean).join('\n');

  return `<plan type="${plan.taskType}" conf="${conf}" mode="${plan.mode}">\n${body}\n</plan>`;
}

/**
 * Verbose markdown format — used when confidence < 0.7 (deep/uncertain tasks).
 * Gives the model more explanation when the plan itself is uncertain.
 */
export function formatExecutionPlanVerbose(plan: ExecutionPlan): string {
  const lines: string[] = [];
  const modeLabel = plan.mode === 'deep' ? ' (deep plan — explore before acting)' : '';
  lines.push(`## Execution Plan${modeLabel}\n`);
  lines.push(`**Task:** ${plan.taskType}  |  **Confidence:** ${Math.round(plan.confidence * 100)}%  — verify steps before committing\n`);

  if (plan.steps.length > 0) {
    lines.push('**Steps (execute in order — adjust based on what you find):**');
    for (const s of plan.steps) {
      const status = s.exists ? '_exists_' : '_create new_';
      lines.push(`${s.id}. \`${s.action}\` → \`${s.file}\` ${status}`);
    }
  }

  if (plan.riskAreas.length > 0) {
    lines.push(`\n**Risk areas:**`);
    for (const r of plan.riskAreas) lines.push(`- ${r}`);
  }

  if (plan.missingInfoQuestions.length > 0) {
    lines.push(`\n**Clarify before acting:**`);
    for (const q of plan.missingInfoQuestions) lines.push(`- ${q}`);
  }

  lines.push('\n_Run deeper research before writing code — confidence is low._');
  return lines.join('\n');
}

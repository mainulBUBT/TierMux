

// Plan-text helpers for Plan mode.
//
// The PRIMARY path no longer lives here: the model declares its plan by calling the
// `exitPlanMode` tool (core/tools/v3/exitPlanMode.ts), so the plan arrives already structured
// and validated. `formatPlanForCard` below is the only thing that stands between that structure
// and the `planProposed` card.
//
// What remains is the FALLBACK ladder for models that reply in prose instead of calling the
// tool: `structurePlanSteps` re-parses confirmed plan prose into a clean string[] via the AI
// SDK's `output` option, and falls back to titles.ts's regex `planStepsToTodos` on any failure.
//
// Deliberately GONE (2026-08-31): `extractPlanFromProse`, the LLM classifier that decided
// whether a prose reply "was a plan". With an explicit tool boundary there is nothing left for
// it to disambiguate, and it cost a whole extra model round-trip on every plan-mode turn the
// regex gate missed.
import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { ProposedPlan } from '../shared/types';
import { createRouterProvider } from './core/routerProvider';

const StepsSchema = z.object({
  steps: z.array(z.string().min(1)).max(20),
});

/** Test seam — mirrors core/engine.ts's `__setEngineModelForTests`. planStructurer used to
 *  take a Router the e2e could fake; with the Router gone it builds its own picker-backed
 *  model, so the fake has to be injected here instead. Production never sets this. */
let modelOverrideForTests: LanguageModel | undefined;
export function __setPlanModelForTests(m: LanguageModel | undefined): void {
  modelOverrideForTests = m;
}

/**
 * Re-parses a confirmed plan's prose into a clean step list via schema-validated structured
 * output. Returns null (never throws) on any failure — timeout, provider rejects `output`,
 * malformed result — so the caller falls back to `planStepsToTodos`'s regex parse.
 */
export async function structurePlanSteps(planText: string): Promise<string[] | null> {
  if (!planText.trim()) return null;
  try {
    const model = modelOverrideForTests ?? createRouterProvider({ taskKind: 'plan' });
    const result = await generateText({
      model,
      system: 'Extract the concrete action steps from this plan as a clean, deduplicated list. '
        + 'One step per array entry, imperative mood, no numbering/bullets in the text itself. '
        + 'Preserve the file/symbol names the plan already names. Do not invent new steps. '
        + 'A before-→after text change (e.g. old line vs new line, a diff, "change X to Y") is '
        + 'ONE step, not two — never split the "before" and "after" text into separate array '
        + 'entries; combine them into a single step like "Change <file> from X to Y".',
      prompt: planText,
      output: Output.object({ schema: StepsSchema }),
      abortSignal: AbortSignal.timeout(15000),
    });
    const steps = result.output?.steps?.map((s: string) => s.trim()).filter(Boolean) ?? [];
    return steps.length ? steps.slice(0, 20) : null;
  } catch {
    return null; // best-effort — the regex parser is the safe fallback
  }
}

/** Re-serializes a clean step list back into the numbered-list text format the webview's
 *  Plan.ts (parsePlanSteps) and titles.ts (planStepsToTodos) both already parse — so
 *  structurePlanSteps' output can be dropped straight into the existing `planProposed.steps`
 *  string field with no changes needed on the webview side. */
export function formatStructuredSteps(steps: string[]): string {
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/**
 * Serialize a tool-declared {@link ProposedPlan} into the numbered-list text the
 * `planProposed` card already carries (`messages.ts`: `steps: string`), so the webview's
 * Plan.ts needs NO change to render a structured plan.
 *
 * The mapping is chosen to feed Plan.ts's own parsers rather than fight them:
 *  - `description` goes above the first list item — that is exactly where
 *    `extractPlanDescription` looks for the lead-in paragraph.
 *  - each step is ONE line starting `N. ` — what `parsePlanSteps` matches.
 *  - `files` are emitted in backticks, because `detectStepFiles` reads backticked spans to
 *    compute the card's "N steps · N files" summary. With the tool, those paths are the
 *    model's declared targets instead of a regex guess at pathish-looking prose.
 */
/** Card-text encoding for the plan's header block. Line-prefixed rather than markdown-sectioned
 *  on purpose: the card text is hand-editable and is parsed back by BOTH this file and the
 *  webview, and `Reading:` cannot collide with the step-bullet regex
 *  (`^\s*(?:[-*]|\d+[.)])\s+`) the way a `- [ ]` line would.
 *  The header block is the READING alone since 2026-09-01 — `Approach:` / `Q:` / `A:` lines are
 *  retired (questions are asked before the plan via askUser, not carried on it), but they still
 *  occur in cards persisted by older sessions, so the re-parsers keep skipping them. */
export const CARD_READING_RE = /^Reading:\s*(.+)$/;
/** Retired header lines (approach / on-card questions and answers), still skipped when
 *  re-parsing a card saved before 2026-09-01 so they do not leak into a re-saved description. */
export const CARD_RETIRED_HEADER_RE = /^(?:Approach|Q|A):\s*/;

export function formatPlanForCard(plan: ProposedPlan): string {
  const lines: string[] = [];
  // Header block FIRST: the reading is the one thing a reader must see before the steps, since
  // a plan can be right in every step and still implement the wrong request.
  if (plan.interpretation?.trim()) lines.push(`Reading: ${plan.interpretation.trim()}`);
  if (lines.length) lines.push('');
  if (plan.description?.trim()) lines.push(plan.description.trim(), '');
  // 'no-change' has no steps by construction — it is a finding, and the host renders it as a
  // normal answer rather than an empty plan card (see chatViewProvider). Kept renderable here
  // so a caller that formats one anyway gets the finding, not a blank string.
  if (plan.outcome === 'no-change') return [...lines, (plan.finding ?? '').trim()].join('\n').trim();
  plan.steps.forEach((step, i) => {
    const files = step.files?.filter(Boolean).map((f) => `\`${f}\``).join(', ');
    const parts = [step.what.trim()];
    if (files) parts.push(`(${files})`);
    // Evidence rides on the card line so the user can CHECK a step's premise before approving
    // it — the 2026-09-01 repro approved a step whose premise a single file read disproved.
    // The card text is the source of truth (steps are hand-editable), so it has to live here
    // rather than in a parallel copy of ProposedPlan.
    if (step.evidence?.trim()) parts.push(`— evidence: ${step.evidence.trim()}`);
    if (step.verify?.trim()) parts.push(`— verify: ${step.verify.trim()}`);
    lines.push(`${i + 1}. ${parts.join(' ')}`);
  });
  return lines.join('\n');
}

const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+\S/;

/**
 * True when `text` is already the shape {@link formatPlanForCard} and the plan card's own
 * `collectSteps()` produce: an optional lead-in paragraph, then nothing but `N. <step>` lines,
 * one step per line.
 *
 * The point is to skip {@link structurePlanSteps} — a whole model round-trip — when there is
 * demonstrably nothing left to structure. Deliberately strict: any stray bullet, heading, or
 * wrapped continuation line makes it false, and the structurer runs as before.
 */
export function isCleanNumberedList(text: string): boolean {
  const lines = String(text || '').split('\n');
  const first = lines.findIndex((l) => NUMBERED_LINE_RE.test(l));
  if (first === -1) return false;
  // Everything before the first numbered line is the description paragraph — but a list marker
  // up there means the text mixes formats, which is exactly what the structurer is for.
  if (lines.slice(0, first).some((l) => /^\s*[-*]\s+\S/.test(l))) return false;
  return lines.slice(first).every((l) => !l.trim() || NUMBERED_LINE_RE.test(l));
}

/** One step, recovered from a card line that {@link formatPlanForCard} wrote (or that the user
 *  hand-edited on the card). The card's text is the source of truth — the user can edit it —
 *  so the file renderer reads structure back OUT of it rather than keeping a second copy that
 *  could silently disagree with what was approved. */
interface ParsedStep {
  what: string;
  files: string[];
  evidence?: string;
  verify?: string;
}

const STEP_VERIFY_RE = /\s+[—-]\s*verify:\s*(.+)$/i;
// Stripped AFTER verify and BEFORE files, matching the line order the card writes:
// `what (files) — evidence: E — verify: V`. Each clause anchors at $ once the ones to its
// right are gone, so no clause has to know about the others' contents.
const STEP_EVIDENCE_RE = /\s+[—-]\s*evidence:\s*(.+)$/i;
const STEP_FILES_RE = /\s+\((`[^`]+`(?:\s*,\s*`[^`]+`)*)\)\s*$/;

/** Split one plan-card line back into `{ what, files, verify }`. Everything is optional: a
 *  hand-typed step with no parens and no verify clause comes back as `what` alone. */
export function parsePlanStepLine(line: string): ParsedStep {
  let rest = line.trim();
  let verify: string | undefined;
  const v = rest.match(STEP_VERIFY_RE);
  if (v) { verify = v[1].trim(); rest = rest.slice(0, v.index).trimEnd(); }
  let evidence: string | undefined;
  const e = rest.match(STEP_EVIDENCE_RE);
  if (e) { evidence = e[1].trim(); rest = rest.slice(0, e.index).trimEnd(); }
  let files: string[] = [];
  const f = rest.match(STEP_FILES_RE);
  if (f) {
    files = f[1].split(',').map((x) => x.trim().replace(/^`|`$/g, '')).filter(Boolean);
    rest = rest.slice(0, f.index).trimEnd();
  }
  return { what: rest, files, evidence, verify };
}

export interface PlanFileMeta {
  title: string;
  /** What the user actually asked for — the single most useful thing the old file format left
   *  out. Reading a saved plan a week later, "why does this plan exist" is unanswerable without it. */
  request?: string;
  /** `approved` = saved for later (Save); `executing` = handed straight to Agent mode (Execute). */
  status: 'approved' | 'executing';
  model?: string;
  sessionId?: string;
  /** Injected for deterministic tests; defaults to now. */
  now?: Date;
}

/** Local-time ISO-8601 with offset (e.g. `2026-08-31T15:06:12+06:00`) — sortable and
 *  unambiguous, unlike the `toLocaleString()` the old header used, which changed meaning with
 *  the reader's locale and could not be sorted or diffed. */
function isoLocal(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    + `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    + `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

function yamlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/**
 * Render an approved plan as the saved `.md` document.
 *
 * Replaces a flat `# Plan: <title>` + locale timestamp + one-line-per-step checklist, which
 * threw away everything the plan actually knew. This version keeps:
 *
 *  - **YAML frontmatter** — machine-readable, so the file can be listed, sorted and (later)
 *    read back in; VS Code and every markdown previewer already render it as a properties table.
 *  - **The original request**, quoted. Without it a saved plan cannot explain itself.
 *  - **Per-step files and verify as sub-bullets** instead of crammed into the checkbox line,
 *    with paths kept in backticks so they stay clickable-ish and greppable.
 *  - **`- [ ]` checkboxes**, so the file doubles as a working checklist while implementing —
 *    which is the only reason the old format's one real idea is kept.
 */
export function renderPlanMarkdown(steps: string, meta: PlanFileMeta): string {
  const lines = steps.split('\n');
  const firstStep = lines.findIndex((l) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l));
  // The header block is recovered from the CARD TEXT like everything else — the user may have
  // edited the reading before saving, and a stored copy of ProposedPlan could silently disagree
  // with what they approved.
  const head = (firstStep === -1 ? lines : lines.slice(0, firstStep)).map((l) => l.trim());
  const reading = head.map((l) => l.match(CARD_READING_RE)?.[1]).find(Boolean)?.trim();
  const description = (firstStep === -1 ? [] : lines.slice(0, firstStep))
    .filter((l) => !CARD_READING_RE.test(l.trim()) && !CARD_RETIRED_HEADER_RE.test(l.trim()))
    .map((l) => l.trim()).filter(Boolean).join(' ').trim();

  const parsed: ParsedStep[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (m?.[1]?.trim()) parsed.push(parsePlanStepLine(m[1]));
  }

  const touched = [...new Set(parsed.flatMap((p) => p.files))];
  const fm = [
    '---',
    `title: ${yamlString(meta.title)}`,
    `created: ${isoLocal(meta.now ?? new Date())}`,
    `status: ${meta.status}`,
    ...(meta.model ? [`model: ${yamlString(meta.model)}`] : []),
    ...(meta.sessionId ? [`session: ${yamlString(meta.sessionId)}`] : []),
    `steps: ${parsed.length}`,
    ...(touched.length ? ['files:', ...touched.map((f) => `  - ${yamlString(f)}`)] : []),
    '---',
  ];

  const body: string[] = ['', '', `# ${meta.title}`, ''];
  if (meta.request?.trim()) {
    body.push(`> **Request** — ${meta.request.trim().replace(/\s+/g, ' ')}`, '');
  }
  if (reading) body.push('## Reading', '', reading, '');
  if (description) body.push(description, '');
  body.push('## Steps', '');
  if (!parsed.length) {
    body.push('_No steps._', '');
  }
  for (const step of parsed) {
    body.push(`- [ ] ${step.what}`);
    if (step.files.length) body.push(`  - Files: ${step.files.map((f) => `\`${f}\``).join(', ')}`);
    if (step.evidence) body.push(`  - Evidence: ${step.evidence}`);
    if (step.verify) body.push(`  - Verify: ${step.verify}`);
  }
  body.push('');
  return `${fm.join('\n')}${body.join('\n')}`;
}

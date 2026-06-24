// Execution templates — deterministic task recipes.
// Each template defines a fixed tool allowlist and a numbered step sequence injected into
// the system prompt. The LLM follows the recipe; it does NOT decide what to do.
// Zero AI in this file — pure keyword matching + fixed workflows.

export type TemplateKind = 'bug' | 'feature' | 'refactor' | 'explain' | 'edit' | 'agent';

export interface ExecutionTemplate {
  kind: TemplateKind;
  /** Ordered steps the LLM MUST follow. Injected as a numbered list. */
  steps: string[];
  /** Tools the LLM is allowed to call in this template. Undefined = unrestricted. */
  allowedTools: string[] | undefined;
  /** Short label for status display. */
  label: string;
  /**
   * Hard output constraint injected at the end of the system prompt.
   * Restricts what the LLM is allowed to output — diff only, JSON only, etc.
   * This collapses hallucination surface from "anything" to one small format.
   */
  outputConstraint: string;
}

// ---- Keyword signals ----
const BUG = /\b(bug|error|exception|stacktrace|stack trace|traceback|failing|fail|failed|broken|crash|throws?|not working|null pointer|undefined|cannot|can't|won't|doesn't)\b|\bnot (?:loading|showing|rendering|working|saving|connecting|fetching)\b/i;
const FEATURE = /\b(add|create|implement|build|make|new|generate|setup|set up|integrate|introduce)\b/i;
const REFACTOR = /\b(refactor|cleanup|clean up|restructure|reorganize|simplify|extract|move|rename|split|consolidate)\b/i;
const EXPLAIN = /\b(explain|how does|how do|what is|what are|where does|where is|describe|overview|walk me through|show me how|tell me|understand|why does|why is)\b/i;
const EDIT = /\b(update|change|modify|fix|adjust|edit|replace|remove|delete|toggle|switch|set|correct)\b/i;

/** Pick the best template for a user query. Falls back to 'agent' for ambiguous cases. */
export function pickTemplate(query: string): TemplateKind {
  const t = query || '';
  if (BUG.test(t)) return 'bug';
  if (FEATURE.test(t)) return 'feature';
  if (REFACTOR.test(t)) return 'refactor';
  if (EXPLAIN.test(t)) return 'explain';
  if (EDIT.test(t)) return 'edit';
  return 'agent';
}

// ---- Templates ----

const TEMPLATES: Record<TemplateKind, ExecutionTemplate> = {

  bug: {
    kind: 'bug',
    label: 'Debug',
    steps: [
      'grep for the error message or failing symbol to find the source location',
      'readFile the exact file and line range where the error occurs',
      'identify the root cause — trace data flow back to the bug origin',
      'edit only the minimal change needed to fix the root cause',
      'verify: getDiagnostics or grep to confirm the fix did not break anything nearby',
    ],
    allowedTools: ['grep', 'readFile', 'glob', 'getDiagnostics', 'editFile', 'writeFile', 'think', 'askUser'],
    outputConstraint:
      'Output the fix as a unified diff (```diff block) showing only the changed lines. ' +
      'Before the diff, write ONE sentence stating the root cause. Nothing else.',
  },

  feature: {
    kind: 'feature',
    label: 'Feature',
    steps: [
      'glob to discover the existing pattern (migration, model, service, controller) for similar features',
      'readFile the closest existing example to understand the exact conventions used',
      'list the files that need to be created or modified in order',
      'implement each file in order: schema/migration → model → service → controller/handler → test',
      'grep to verify imports and symbol names are consistent across all new files',
    ],
    allowedTools: ['grep', 'readFile', 'glob', 'editFile', 'writeFile', 'createFile', 'listDir', 'think', 'askUser', 'getDiagnostics'],
    outputConstraint:
      'Output only the implementation — code blocks for each file, labelled with the file path. ' +
      'No long preamble. No "Here is what I will do" prose. Just the code.',
  },

  refactor: {
    kind: 'refactor',
    label: 'Refactor',
    steps: [
      'grep for all usages of the symbol, function, or pattern being refactored',
      'readFile each affected file to understand how it is used',
      'plan the change: list every file that will be modified and what changes',
      'apply changes one file at a time — do not skip files',
      'grep the old symbol name again to confirm zero remaining references',
    ],
    allowedTools: ['grep', 'readFile', 'glob', 'editFile', 'writeFile', 'listDir', 'think', 'askUser', 'getDiagnostics'],
    outputConstraint:
      'Output a unified diff (```diff block) for each changed file. ' +
      'Do not restate the plan — just apply the changes.',
  },

  explain: {
    kind: 'explain',
    label: 'Explain',
    steps: [
      'grep for the symbol, function, or pattern the user asked about',
      'readFile the relevant section (do not read the whole file — only the relevant lines)',
      'trace any key dependencies: grep for what it calls or imports',
      'write a clear explanation with file:line references for every claim',
    ],
    allowedTools: ['grep', 'readFile', 'glob', 'codebaseSearch', 'listDir', 'think', 'getSymbolGraph'],
    outputConstraint:
      'Output a structured explanation using ## headers. ' +
      'Every code fact MUST have a file:line reference (e.g. `src/service.ts:42`). ' +
      'No speculation. If something is unclear, say "not found in context" — do not guess.',
  },

  edit: {
    kind: 'edit',
    label: 'Edit',
    steps: [
      'grep or glob to locate the exact file and line to change',
      'readFile the surrounding context (±20 lines) before editing',
      'make the minimal targeted edit — change only what was asked',
      'getDiagnostics to confirm no type errors or lint issues introduced',
    ],
    allowedTools: ['grep', 'readFile', 'glob', 'editFile', 'writeFile', 'getDiagnostics', 'think', 'askUser'],
    outputConstraint:
      'Make only the change that was asked. Do not refactor surrounding code. ' +
      'Do not add comments explaining the change. Output the edit silently.',
  },

  agent: {
    kind: 'agent',
    label: 'Agent',
    steps: [
      'gather context: grep and readFile to understand the relevant code before acting',
      'identify all files that need to change',
      'make changes in a logical order — dependencies before dependents',
      'verify the result with getDiagnostics or grep',
    ],
    allowedTools: undefined,
    outputConstraint: '',
  },
};

/** Get the full template definition for a kind. */
export function getTemplate(kind: TemplateKind): ExecutionTemplate {
  return TEMPLATES[kind];
}

/**
 * Global structured answer format injected for all templates.
 * Weak models produce dramatically more reliable output when given a fixed schema.
 */
const STRUCTURED_OUTPUT_FORMAT = `# Required output format
Always respond in this exact structure — no exceptions:

## ANSWER
[your answer here — concise, factual, no filler]

## FILES
[list every file you read or changed, one per line, as path:line]

If no files are relevant, write "## FILES\nnone".
Do NOT add any other top-level sections. Do NOT write prose outside these sections.`;

/**
 * Build the system prompt block for the current template.
 * Injected after the main system prompt so it is always visible to the model.
 */
export function templatePromptBlock(template: ExecutionTemplate): string {
  const steps = template.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const parts = [
    `# Execution recipe: ${template.label}`,
    `Follow these steps **in order**. Do not skip steps. Do not decide your own plan.`,
    steps,
    `Do not call tools outside this recipe unless absolutely necessary.`,
  ];
  if (template.outputConstraint) {
    parts.push(`\n# Task-specific constraint\n${template.outputConstraint}`);
  }
  parts.push(`\n${STRUCTURED_OUTPUT_FORMAT}`);
  return parts.join('\n');
}

# Plan — Migrate TierMux Prompts to Markdown-based System

## Context

TierMux currently hardcodes 9 prompt strings in `src/agent/prompts.ts` (241 lines). Every prompt edit requires a TypeScript rebuild and re-publishing the extension. This blocks three valuable workflows:

1. **Community PRs** — non-developers can't improve prompts without touching `.ts`
2. **A/B testing** — comparing prompt variants requires code changes, not just file swaps
3. **Prompt versioning** — Git diffs of MD files are far more readable than diffs of template-literal strings

OpenCode, Kilo, and Cline all use Markdown-based prompt systems. TierMux should too — especially since the project is being prepared for open source.

## Goals

- Move all static prompt content (system prompts, mode recipes, output rules) into `.md` files
- Keep dynamic data injection (pre-research, VM context, conversation memory, template) in TypeScript
- Preserve byte-for-byte behaviour: bench must not regress
- Zero rebuild for prompt edits (file watcher invalidates the cache)

## Non-goals

- **Don't** move project-specific prompts ("Fix Laravel OrderService…") into MD — keep behaviour generic, project context stays in TS
- **Don't** introduce a full template engine (Handlebars, Mustache, EJS) — a single-pass `{{var}}` replace is sufficient
- **Don't** move the `templates.ts` execution recipes (bug/feature/refactor/explain/edit) into MD yet — those are tightly coupled to `pickTemplate()` and template-prompt rendering. They can be migrated in a follow-up.

## Target structure

```
TierMux/                                        (existing)
├── src/                                        (existing TS — runtime only)
│   ├── agent/
│   │   ├── agent.ts                            (unchanged)
│   │   ├── prompts.ts                          (slimmed: re-exports from PromptLoader)
│   │   ├── promptLoader.ts                     (NEW: loads .md, renders {{var}}, caches)
│   │   └── templates.ts                        (unchanged for this PR)
│   └── context/, router/, providers/...        (unchanged)
│
└── prompts/                                    (NEW top-level dir — NOT in src/)
    ├── system/
    │   ├── responsibility.md                   (RESPONSIBILITY_RULES — line 9-15)
    │   ├── chat.md                             (CHAT_SYSTEM — line 17-58)
    │   ├── agent.md                            (AGENT_SYSTEM — line 60-127)
    │   ├── agent-lite.md                       (AGENT_SYSTEM_LITE — line 134-155)
    │   ├── debug.md                            (DEBUG_SYSTEM — line 157-165)
    │   ├── orchestrator.md                     (ORCHESTRATOR_SYSTEM — line 167-169)
    │   ├── plan.md                             (PLAN_SYSTEM — line 171-224)
    │   ├── summary.md                          (SUMMARY_SYSTEM — line 226-229)
    │   └── title.md                            (TITLE_SYSTEM — line 231-237)
    │
    ├── recipes/                                (per-template recipe content)
    │   ├── bug.md                              (extracted from templates.ts bug steps)
    │   ├── feature.md                          (extracted from templates.ts feature steps)
    │   ├── refactor.md                         (extracted from templates.ts refactor steps)
    │   └── edit.md                             (extracted from templates.ts edit steps)
    │   # (explain.md stays in templates.ts for this PR — see Non-goals)
    │
    ├── rules/                                  (cross-cutting rules, embedded into system prompts)
    │   ├── output-format.md                    (STRUCTURED_OUTPUT_FORMAT — templates.ts:148-158)
    │   ├── pre-research-mandatory.md            (PRE-RESEARCH rule from AGENT_SYSTEM line 90-98)
    │   └── investigation-loop.md                (RULE 1b, RULE 2 from AGENT_SYSTEM line 100-117)
    │
    └── examples/                               (few-shot patterns, optional — added in Phase 3)
        ├── diff-good.md
        └── diff-bad.md
```

**Two-tier lookup** mirrors OpenCode's pattern:
- `system/*.md` — mode-level persona and rules
- `rules/*.md` — cross-cutting rules injected into multiple system prompts
- `recipes/*.md` — per-template workflow steps (Phase 2)
- `examples/*.md` — few-shot demonstrations (Phase 3, optional)

The split keeps each file focused: `chat.md` is the chat persona, `debug.md` is the debug persona, `pre-research-mandatory.md` is the rule that BOTH `agent.md` and `plan.md` include.

## What goes in MD vs TS

### Markdown (static behaviour, project-agnostic)

| MD file | Source | Why MD |
|---------|--------|-------|
| `system/chat.md` | `CHAT_SYSTEM` | Persona, search rules, identity response |
| `system/agent.md` | `AGENT_SYSTEM` | Persona, orient/verify/think/plan rules, "ALWAYS have tools", recovery |
| `system/agent-lite.md` | `AGENT_SYSTEM_LITE` | Short, imperative version for weak models |
| `system/debug.md` | `DEBUG_SYSTEM` | Debug-specific 4-step loop |
| `system/orchestrator.md` | `ORCHESTRATOR_SYSTEM` | Subtask-splitting rules |
| `system/plan.md` | `PLAN_SYSTEM` | 4-stage confidence pipeline |
| `system/summary.md` | `SUMMARY_SYSTEM` | Compression-only instruction |
| `system/title.md` | `TITLE_SYSTEM` | Title generation rules |
| `system/responsibility.md` | `RESPONSIBILITY_RULES` | Universal preamble (referenced by all modes) |
| `rules/output-format.md` | `STRUCTURED_OUTPUT_FORMAT` | Universal "## ANSWER / ## FILES" header |
| `rules/pre-research-mandatory.md` | AGENT_SYSTEM line 90-98 | "Trust pre-research" rule, applies to agent + plan |
| `rules/investigation-loop.md` | AGENT_SYSTEM line 100-117 | "If pre-research is empty, investigate" + "Never grep twice" |

### TypeScript (dynamic context, runtime values)

| TS module | Why stays in TS |
|-----------|-----------------|
| `agent.ts:485-619` — pre-research pipeline | Returns real values per query (symbol hits, bundle cache, inverted index) |
| `vmContext.ts` — VM context block | Includes git diff, last error, active file — all per-session |
| `conversationMemory.ts` — last 3-5 turns | Compresses dynamic history |
| `executionMemory.ts` — files modified | Tracked per-run |
| `compressToolResult.ts` — grep output, FLOW chain | Generated per tool result |
| `templates.ts` — explain template (for now) | Tightly coupled to `pickTemplate()` keyword match |
| `pickTemplate()` — keyword detection | Rule-based, not LLM |
| `bundles, indexes, graph` — all of `src/context/*` | Dynamic data |

## Template engine

`promptLoader.ts` is a small module — ~80 lines, no dependencies. Its API:

```typescript
// src/agent/promptLoader.ts
export class PromptLoader {
  /** Load + cache all MD files under prompts/. Returns the raw text. */
  static get(name: string): string;

  /** Render a prompt: read MD, replace {{vars}}, return final string. */
  static render(name: string, vars: Record<string, string>): string;

  /** Invalidate cache (called on file-watcher change). */
  static invalidate(): void;
}
```

**Variable substitution** is a single regex pass:
```typescript
text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
```

No conditionals, no loops, no includes. If we ever need `{{>partial}}` or `{{#if}}`, we promote to a real engine. Today: KISS.

**Caching**:
- `_cache: Map<string, {mtime: number, text: string}>` keyed on relative path
- `get()` checks `fs.statSync()` mtime against cached mtime; reloads on mismatch
- `_cache` is module-level so all callers share it
- Extension activation pre-warms by reading every MD once (cheap, ~5KB total)

**File watching**:
- `vscode.workspace.createFileSystemWatcher('**/prompts/**/*.md')` — on change, invalidate
- One watcher per extension host, registered in `extension.ts:activate()`

**Loading at runtime**:
- MD files are loaded with `fs.readFileSync` (synchronous — they're <5KB, and we want them before the first model call)
- The loader resolves `${PRODUCT_NAME}` automatically (constant from `shared/branding.ts`)
- The loader is called from `agent.ts` where each constant used to be imported

## Migration phases

### Phase 1 — Extract `system/*.md` (9 files, 1-2 hours)

1. Create `prompts/system/` directory with the 9 MD files above
2. Copy content from `prompts.ts` line-by-line (preserve all wording — bench must not regress)
3. Create `src/agent/promptLoader.ts` (~80 lines: get, render, cache, watch)
4. Update `src/agent/prompts.ts` to be a thin re-export:
   ```typescript
   import { PromptLoader } from './promptLoader';
   export const RESPONSIBILITY_RULES = PromptLoader.get('system/responsibility');
   export const CHAT_SYSTEM = PromptLoader.render('system/chat', { productName: PRODUCT_NAME });
   // ... etc for all 9 exports
   ```
5. Add the file watcher in `extension.ts`
6. **Validation**: re-run the explain bench (10 queries). All 4 day-1 KPIs must match the pre-migration baseline within ±0.5%

### Phase 2 — Extract `recipes/*.md` (4 files, 1 hour)

1. Extract the `steps` arrays from `templates.ts` (bug/feature/refactor/edit) into `prompts/recipes/*.md`
2. Add `recipes.md` to `promptLoader` API (loads + joins steps into a numbered list)
3. Update `templatePromptBlock` to compose the recipe from MD + the in-code `outputConstraint` + `STRUCTURED_OUTPUT_FORMAT`
4. **Validation**: explain bench (recipe for `explain` still in TS), bug bench on a single case if available

### Phase 3 — Extract `rules/*.md` (3 files, 30 min)

1. Pull out the `## RULE 1`, `## RULE 1b`, `## RULE 2`, and `STRUCTURED_OUTPUT_FORMAT` into `prompts/rules/*.md`
2. Update `system/agent.md` and `system/plan.md` to reference these via `{{>pre-research-mandatory}}` syntax — or compose them in the loader (e.g. `PromptLoader.compose('agent', ['pre-research-mandatory', 'investigation-loop'])`)
3. **Validation**: agent-mode bench on 1-2 queries — check the composed prompt matches byte-for-byte

### Phase 4 — Community-ready (optional, post-MVP)

1. Add `examples/*.md` (good diff, bad diff, good test) — few-shot for the agent
2. Write a `prompts/README.md` explaining the structure, the variable names available, and how to PR a new prompt
3. Add a `prompts/CHANGELOG.md` for tracking A/B test results
4. Add a "Edit prompt" VSCode command (workspace command) that opens the active mode's MD

## Edge cases to handle

### 1. `${PRODUCT_NAME}` substitution

Today: `template` literals in TS interpolate at compile time.
After: MD contains `{{productName}}` and the loader interpolates at load time. **One risk**: if a prompt contains literal `$` characters (e.g. shell commands, regex), the JS template-literal style `${...}` is inert — but `{{...}}` would need careful escaping. **Mitigation**: the loader uses a precise regex `/\{\{(\w+)\}\}/g` that ONLY matches `{{name}}` with a word boundary — `$` doesn't appear in the match. **Safe**.

### 2. Backslash-escaped characters in TS

The current prompts use `\\\`` (escaped backtick inside a template literal). MD doesn't have this issue — backticks are just backticks. **Conversion risk**: any backtick that's meant to be a literal in the rendered text must NOT be a code-fence opener. **Mitigation**: when copying, the human reviewer scans for triple-backticks and verifies each is intended as a code fence.

### 3. The "Code investigation loop" pre-research rule

Currently in `AGENT_SYSTEM` (line 90-117). It's three rules (RULE 1, RULE 1b, RULE 2) that together form the "investigation loop" — a separate concept from the agent persona. **Best MD location**: `prompts/rules/investigation-loop.md` (the 3 rules as one file). Injected into `system/agent.md` and `system/plan.md` (both modes need it).

### 4. The `{{var}}` syntax colliding with shell-like text

A prompt may say something like `Use {{ grep } for...`. The `{{ grep }}` would be interpreted as a variable. **Mitigation**: the regex `/\{\{(\w+)\}\}/g` requires the closing `}}` immediately after the name, with no spaces inside. A backtick-fenced code block containing `{{var}}` is still a code block — the variable interpolation happens BEFORE rendering, so the MD text goes into the prompt as-is. The model then sees `{{var}}` in its context. **No collision risk** if we restrict to `{{name}}` (no spaces, no punctuation inside).

### 5. Caching across extension reloads

When the extension reloads (F5 in dev), the module reloads, the cache rebuilds. Cost: ~5ms (5 files × 1KB each, sync reads). **Acceptable**.

### 6. MD files outside the extension's distribution

`prompts/` at the repo root is OUTSIDE the published VSIX. If we want users to be able to edit prompts locally, we need to ship the MD files with the extension.

**Two options**:
- (A) Ship `dist/prompts/` as a resource — `vscode.workspace.fs.readFile` reads from the extension's install dir at runtime
- (B) Bundle MD files at build time into a TS module (`bundledPrompts.ts`) and ship them as a single file

**Recommendation**: (A). VSCode's `ExtensionContext.asAbsolutePath('prompts/...')` resolves resources relative to the extension's install dir. This lets users copy the extension's MD to their workspace and override — true customisability.

### 7. Workspace-level overrides

A user (or a project) might want to override TierMux's default prompts. **Pattern**:
- Check `<workspaceRoot>/.tiermux/prompts/` first
- Fall back to extension's bundled `dist/prompts/`
- One-time log when an override is found ("Using workspace prompt: agent.md")

This is the same pattern as the existing `.tiermux/synonyms.json`. **Add it in Phase 1** (it's two extra `fs.existsSync` checks).

## What stays in TS (and why)

1. **The 9 prompt constants** in `prompts.ts` (now as thin re-exports) — TypeScript imports stay the same, no caller changes
2. **Dynamic context injection** — `preResearch`, `vmContext`, `conversationMemory`, `compressToolResult` output — all per-query data
3. **`pickTemplate()`** — keyword detection, rule-based
4. **The `explain` template** — Phase 1 only; the other 4 templates get extracted in Phase 2
5. **`STRICT_OUTPUT_FORMAT` rendering** — string assembly in `templates.ts:164-177`
6. **All tool specs, all routing logic, all telemetry, all graph code** — none of this is prompt-related

## Files touched

| File | Phase | Action |
|------|-------|--------|
| `prompts/system/responsibility.md` | 1 | new (extract from `prompts.ts:9-15`) |
| `prompts/system/chat.md` | 1 | new (extract from `prompts.ts:17-58`) |
| `prompts/system/agent.md` | 1 | new (extract from `prompts.ts:60-127`) |
| `prompts/system/agent-lite.md` | 1 | new (extract from `prompts.ts:134-155`) |
| `prompts/system/debug.md` | 1 | new (extract from `prompts.ts:157-165`) |
| `prompts/system/orchestrator.md` | 1 | new (extract from `prompts.ts:167-169`) |
| `prompts/system/plan.md` | 1 | new (extract from `prompts.ts:171-224`) |
| `prompts/system/summary.md` | 1 | new (extract from `prompts.ts:226-229`) |
| `prompts/system/title.md` | 1 | new (extract from `prompts.ts:231-237`) |
| `src/agent/promptLoader.ts` | 1 | new (~80 lines) |
| `src/agent/prompts.ts` | 1 | replace with thin re-exports |
| `src/extension.ts` | 1 | add file watcher (10 lines) |
| `prompts/recipes/bug.md` | 2 | new (extract from `templates.ts:48-54`) |
| `prompts/recipes/feature.md` | 2 | new (extract from `templates.ts:61-76`) |
| `prompts/recipes/refactor.md` | 2 | new (extract from `templates.ts:82-91`) |
| `prompts/recipes/edit.md` | 2 | new (extract from `templates.ts:113-127`) |
| `src/agent/templates.ts` | 2 | load steps from MD instead of inline arrays |
| `prompts/rules/output-format.md` | 3 | new (extract from `templates.ts:148-158`) |
| `prompts/rules/pre-research-mandatory.md` | 3 | new (extract from `agent.md` RULE 1) |
| `prompts/rules/investigation-loop.md` | 3 | new (extract from `agent.md` RULE 1b + RULE 2) |
| `prompts/README.md` | 4 | new (community docs) |

## Validation strategy

After Phase 1, **re-run the 10-query explain bench**. Pass criteria:

- `symbolHitRate` matches baseline within ±2 percentage points
- `windowReadRate` matches baseline within ±2 percentage points
- `avgToolCalls` matches baseline within ±0.3
- `timeouts === 0`

**Spot check**: the rendered system prompt must be **byte-identical** to the TS string it replaced. Add a unit test:

```typescript
// src/agent/promptLoader.test.ts (or inline in promptLoader.ts)
test('chat.md renders to the same string as the old CHAT_SYSTEM', () => {
  const fromMd = PromptLoader.render('system/chat', { productName: 'TierMux' });
  const fromTs = `You are TierMux, a skilled software engineer assistant...`; // old constant
  expect(fromMd).toBe(fromTs);
});
```

This catches: lost backticks, dropped `{{}}` literal text, wrong variable substitution, lost newlines.

After Phase 2, also run the 50-query bench. **Pass criterion**: retrieval/reasoning/answer must not regress.

## Risks and mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| MD file shipped wrong in VSIX | prompts broken on first run | low | `esbuild.js` adds `prompts/**/*` to the bundle via `vsce.package --no-dependencies`; verified by `vsce ls` |
| Workspace MD override silently replaces TierMux prompt | user reports "TierMux is broken" | low | Log on first load when workspace override is detected; add a `TierMux: Reset prompts to defaults` command |
| File watcher leaks | extension slowdown | low | Single watcher per workspace, registered once in `activate()` |
| `{{var}}` syntax inside MD | prompt is wrong | low | Regex `/\{\{(\w+)\}\}/g` is precise; spot-check tests in Phase 1 |
| Community PR with backtick syntax error | prompt fails to render | low | Each PR is a 1-file change; reviewer scans visually |
| Migration introduces regression in bench | symbol/window/cache KPIs drop | medium | Validation gate after Phase 1 — don't proceed if regressed |
| MD file size grows | more tokens per call | low | MD is currently <5KB total; size is bounded by quality, not format |

## What this enables (post-migration)

- **A/B testing prompts**: a developer can `cp prompts/system/agent.md prompts/system/agent.v2.md`, switch via a setting, compare bench scores
- **Community PRs**: anyone can fix a prompt bug without setting up the TS dev environment
- **Prompt versioning**: each `agent.md` change is a single-file diff, easy to review and revert
- **Per-project customisation**: a workspace can ship its own `prompts/system/agent.md` overriding TierMux's default
- **Non-developer accessibility**: a writer/PM can tweak `chat.md` to improve response style
- **Localised prompts**: `prompts/system/agent.bn.md` (Bengali) or `agent.zh.md` (Chinese) for multilingual UX

## Open questions

1. **Should `STRUCTURED_OUTPUT_FORMAT` move to MD or stay in `templates.ts`?** — Recommend MD (Phase 3), because it's a rule that multiple modes follow. But it's tightly coupled to `pickTemplate()` rendering, so Phase 1 keeps it in TS.
2. **Should we ship a `prompts/README.md` in Phase 1 or Phase 4?** — Recommend Phase 1 (5 minutes of work, makes the migration discoverable for future contributors).
3. **Should MD files be user-visible in the VSCode Explorer?** — Recommend yes: add a `prompts/` folder to `.vscode/settings.json`'s `files.exclude` exclusions (or include them in the workspace). Up to the project owner.
4. **How do we handle `{{}}` literal text inside code blocks (e.g. `bash: echo "{{VAR}}"`)?** — The regex only matches `{{name}}` where name is `\w+`. A backtick-fenced code block containing `{{var}}` doesn't match the regex because the closing `}}` is on the same line as the name, and the backticks are NOT inside the variable. **Safe by design** — no escape needed.

## Estimated effort

| Phase | Effort | What ships |
|-------|--------|------------|
| 1 | 1-2 hours | 9 system MDs + loader + watcher. Backwards compat. Bench regresses by zero. |
| 2 | 1 hour | 4 recipe MDs. Bug/feature/refactor/edit prompts editable. |
| 3 | 30 min | 3 rule MDs. Universal rules centralised. |
| 4 | optional | Examples + community docs |

**Total for MVP-ready migration**: 3-4 hours, two PRs, zero bench impact.

## Final recommendation

**Yes, migrate.** The architecture is right, the scope is small, the validation is clear, and the long-term benefits (community PRs, A/B testing, prompt versioning) are substantial. TierMux is the kind of project that benefits most from a prompt-editor-friendly format because **prompts are the product** — the TS code is just plumbing to deliver them.

Start with Phase 1 (system prompts only) and validate against the explain bench. If KPIs hold, ship. Then Phase 2-3 in follow-up PRs.

## Architecture v2 (revised per feedback — 2026-06-26)

The user identified 5 changes that transform this from "MD migration" to "extensible prompt platform":

### 1. PromptRegistry (not raw PromptLoader)

Replace the flat `PromptLoader` API with a registry that loads everything once, validates upfront, and exposes typed accessors.

```typescript
// src/agent/promptRegistry.ts
export interface PromptEntry {
  /** Path relative to the prompts/ root, e.g. "system/chat" or "rules/output-format" */
  id: string;
  /** Where this prompt was loaded from (workspace, user, bundled) */
  source: 'workspace' | 'user' | 'bundled';
  /** Frontmatter metadata */
  version: number;
  description?: string;
  variables: string[];
  benchmarkRequired: boolean;
  /** Raw MD text after frontmatter stripping */
  body: string;
  /** Resolved includes (recursive, deduped) */
  includes: Map<string, PromptEntry>;
}

export class PromptRegistry {
  /** Load, validate, and cache all prompts. Idempotent; safe to call from extension activate(). */
  static load(ctx: ExtensionContext): PromptRegistry;

  /** Get a prompt by dotted path. Throws if not found OR if validation failed during load. */
  get(category: 'system' | 'rule' | 'recipe' | 'example', name: string): PromptEntry;

  /** Render a prompt with the given variables. Variables not declared in frontmatter throw. */
  render(category: 'system' | 'rule' | 'recipe' | 'example', name: string, vars: Record<string, string>): string;

  /** Returns all known prompts for the picker UI. */
  list(): PromptEntry[];

  /** Force a re-scan. Called on file watcher events. */
  invalidate(): void;

  /** Returns the merged metadata for telemetry. */
  metadata(): { [id: string]: { version: number; source: string } };

  /** Validation results from load(). Empty array = pass. */
  diagnostics(): ValidationDiagnostic[];
}

export interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  promptId: string;
  message: string;
  hint?: string;
}
```

**Public API used by `prompts.ts` becomes**:
```typescript
import { promptRegistry } from './promptRegistry';
export const CHAT_SYSTEM = promptRegistry.render('system', 'chat', { productName: PRODUCT_NAME });
export const AGENT_SYSTEM = promptRegistry.render('system', 'agent', { productName: PRODUCT_NAME });
// ... etc
```

**Why this is better**:
- Typo-proof: `promptRegistry.get('system', 'chat')` is checked at compile time against the categories
- One source of truth: all prompt metadata is queryable
- Telemetry: every model call can record which prompt version it used
- Future-proof: the same registry powers the prompt editor UI, marketplace, A/B tests, and enterprise packs

### 2. Frontmatter metadata

Every MD file starts with YAML frontmatter:

```markdown
---
id: agent
version: 5
description: Main coding agent — autonomous, can edit files
variables:
  - productName
  - vmContext
  - template
benchmark:
  required: true
  regressionThreshold: 0.05
---

# Body starts here.

You are {{productName}}, an autonomous software engineer...
```

**Parsed fields** (all optional except `version`):
- `id` — defaults to filename without `.md` (e.g. `agent` for `agent.md`)
- `version` — integer, defaults to 1. Telemetry tags every model call with `prompt_v: {id}_{version}`
- `description` — short summary, used by `list()` for the picker UI
- `variables` — list of `{{var}}` names the prompt accepts. If a render call passes a name not in this list, the registry warns (and continues, for back-compat)
- `benchmark.required` — if `true`, bench runs without this prompt fail the run. Used to gate MVP freeze.
- `benchmark.regressionThreshold` — max allowed KPI regression vs the v7 baseline (0.05 = 5%)

**Why this matters**:
- A/B test is just "change `version: 5` to `version: 6` in the new MD, run bench, diff KPIs"
- UI editor can show "this prompt is at v5, last validated 3 days ago"
- Telemetry can answer "which prompt version produced this answer"

### 3. `{{include:...}}` support

Prompts can compose other prompts:

```markdown
---
id: agent
version: 5
includes:
  - rules/pre-research-mandatory
  - rules/investigation-loop
  - rules/output-format
---

# Agent persona

You are {{productName}}, an autonomous coding agent...

{{include:rules/pre-research-mandatory}}

{{include:rules/investigation-loop}}
```

**Resolution rules**:
- Includes are resolved at `load()` time, not at render time (composition is static)
- The included MD body is inserted at the `{{include:...}}` position
- Recursive includes are flattened (A includes B, B includes C → A's body has B's body, then C's body)
- Circular includes (`A → B → A`) → **validation error**, fail the load
- The same include appearing twice in one prompt → **deduped** (B included once even if mentioned twice)

**Why this matters**:
- One rule, one place to edit. The "pre-research is authoritative" rule lives in `rules/pre-research-mandatory.md` and is included by both `system/agent.md` and `system/plan.md`
- Prompt diffs become small. A change to the rule → only the rule file changes; the consumers stay the same
- Phase 3 (rules) becomes trivial: extract from `system/agent.md` to `rules/*.md`, add an include line

### 4. Three-level override priority

Resolution order, first wins:
1. **`<workspaceRoot>/.tiermux/prompts/*.md`** — per-project customisation. A team can ship a custom `agent.md` with their team's coding style baked in.
2. **`~/.tiermux/prompts/*.md`** — per-user personalisation. A user can override TierMux's defaults with their own preferred wording.
3. **`<extension>/prompts/*.md`** — bundled defaults. Shipped with the VSIX.

**Implementation**:
```typescript
// In PromptRegistry.load()
const searchPaths = [
  vscode.Uri.joinPath(workspaceRoot, '.tiermux/prompts'),
  vscode.Uri.file(path.join(os.homedir(), '.tiermux/prompts')),
  vscode.Uri.joinPath(ctx.extensionUri, 'prompts'),
];
// Walk the merged tree, first match wins per file.
```

**Why three levels, not two**:
- Workspace = team-shared (commit to git, all team members see it)
- User = personal taste (committed nowhere)
- Bundled = upstream TierMux default

This matches the existing pattern (`.tiermux/synonyms.json` is per-workspace, not per-user, but a user-level default would let individuals tune without changing the project).

### 5. Validation on load

`PromptRegistry.load()` runs all checks upfront. Failures are reported via `diagnostics()` and the registry refuses to render broken prompts.

Checks:
- ✓ **Frontmatter is valid YAML** — `yaml.parse()` doesn't throw
- ✓ **All `{{var}}` references match declared `variables:`** — if `body` uses `{{foo}}` but frontmatter doesn't list `foo`, warn
- ✓ **All `{{include:...}}` references resolve** — and are not circular
- ✓ **No duplicate IDs** across the three sources (a workspace `system/chat.md` and a user `system/chat.md` → workspace wins, but log a warning)
- ✓ **Required benchmarks are present** — if `benchmark.required: true` for `system/agent`, it must be in the loaded set
- ✓ **Variable substitutions don't produce unused-var warnings** — if a var is in frontmatter but never used in body, info-level diagnostic

**Failure modes**:
- Validation error → `promptRegistry.get()` throws. Caller's `prompts.ts` re-export will fail at import time, surfacing the broken prompt at extension activation, not at model call.
- Validation warning → logged once, prompt still works. Telemetry tags the call as `prompt_warnings: [...]`.

## Updated target structure

```
TierMux/
├── src/agent/
│   ├── agent.ts
│   ├── prompts.ts                  (thin re-exports via promptRegistry.render)
│   ├── promptRegistry.ts           (NEW: load/validate/render/list/invalidate/metadata)
│   ├── promptFrontmatter.ts        (NEW: parse + validate frontmatter, ~40 lines)
│   ├── promptIncludeResolver.ts    (NEW: resolve {{include:...}}, detect cycles, ~50 lines)
│   └── templates.ts                 (templates keep their `steps` for now, Phase 2+ migrate)
│
└── prompts/                        (NEW top-level)
    ├── system/                     (Phase 1)
    │   ├── responsibility.md
    │   ├── chat.md
    │   ├── agent.md
    │   ├── agent-lite.md
    │   ├── debug.md
    │   ├── orchestrator.md
    │   ├── plan.md
    │   ├── summary.md
    │   └── title.md
    │
    ├── rules/                      (Phase 3 — extracted AFTER system)
    │   ├── output-format.md
    │   ├── pre-research-mandatory.md
    │   └── investigation-loop.md
    │
    ├── recipes/                    (Phase 2 — depends on rules)
    │   ├── bug.md
    │   ├── feature.md
    │   ├── refactor.md
    │   └── edit.md
    │
    └── examples/                   (Phase 4 — optional)
        ├── diff-good.md
        ├── diff-bad.md
        └── test-good.md
```

## Revised phases (per feedback: rules before recipes)

### Phase 1 — Foundation: system MDs + registry + frontmatter + validation
**Effort: 4-5 hours** (slightly more than original Phase 1 due to registry + frontmatter parser)

1. Create `prompts/system/` with the 9 MD files, each with frontmatter
2. Create `src/agent/promptFrontmatter.ts` (~40 lines: parse YAML, validate shape)
3. Create `src/agent/promptRegistry.ts` (~200 lines: load/validate/render/list/metadata)
4. Update `src/agent/prompts.ts` to call `promptRegistry.render()`
5. Add file watcher in `extension.ts`
6. Add three-level override resolution
7. **Validation**: re-run the 10-query explain bench. KPIs must match v7 baseline within ±0.5%. **Spot check test**: rendered prompt must byte-equal old TS constant.

### Phase 2 — Rules extracted to MD (with includes)
**Effort: 1-2 hours**

1. Create `prompts/rules/` with 3 files
2. Add `{{include:...}}` support to the registry
3. Update `system/agent.md` and `system/plan.md` to use includes
4. Add cycle detection
5. **Validation**: agent-mode bench (1-2 queries). Composed prompt must byte-equal pre-include version.

### Phase 3 — Recipes extracted (templates)
**Effort: 1 hour**

1. Create `prompts/recipes/` with 4 files (bug/feature/refactor/edit)
2. Migrate the `steps:` arrays from `templates.ts` to MD
3. Add recipe metadata (which tool set, which output constraint)
4. **Validation**: 50-query bench must not regress

### Phase 4 — Community-ready (optional)
**Effort: 1-2 hours**

1. Add `examples/` (good diff, bad diff, good test)
2. Write `prompts/README.md` (community docs)
3. Add `prompts/CHANGELOG.md`
4. Add `TierMux: Edit active prompt` command

## Telemetry integration

`PromptRegistry` exposes metadata that the bench runner consumes:

```typescript
// In agent.ts, after a model call:
const promptMeta = promptRegistry.metadata();
for (const [id, info] of Object.entries(promptMeta)) {
  telemetry.recordPromptVersion(id, info.version, info.source);
}
```

This goes into the existing bench `summary.json`:
```json
{
  "kpis": { ... },
  "prompts": {
    "system/agent": { "version": 5, "source": "bundled" },
    "system/chat": { "version": 3, "source": "bundled" },
    "system/plan": { "version": 2, "source": "workspace", "overrides": ["system/plan"] }
  }
}
```

A/B tests become: run bench with `agent.md v5`, save summary, bump to `v6`, re-run, diff.

## What this enables (the long-term vision)

- **Prompt Editor** — a UI panel that lists all prompts, shows their current version, and lets the user edit MD with live preview of the rendered output. The registry is the data layer.
- **Prompt Marketplace** — a registry of community-maintained prompts (`tiermux-prompts/laravel-expert`, `tiermux-prompts/python-ml`, `tiermux-prompts/rust-cli`). Install = drop MD files into a directory the registry scans.
- **A/B Testing** — two versions of the same prompt run against the bench; KPIs compared. The version metadata makes this trivial.
- **Community Prompt Packs** — share a directory of MD files + a manifest. Users `git clone` into `<userDir>/.tiermux/packs/laravel-expert/` and the registry picks them up.
- **Enterprise Prompt Packs** — same pattern but locked to a paid model. Enterprises ship their team's voice + coding style as a private pack.

All of this is unlocked by the registry + frontmatter + three-level override + includes primitives. The migration becomes the **seed** of a platform, not just a refactor.

## Why this is merge-worthy

Without these 5 changes, the migration is a cleanup. With them, it becomes:

- **Free prompt A/B testing** — every change is a version bump + a bench rerun
- **Free community contributions** — PRs are 1-file MD changes
- **Free per-team customisation** — workspace override is just a directory
- **Free per-user customisation** — `~/.tiermux/prompts/` is just another directory
- **Free prompt versioning** — Git diffs + the `version` field give full history
- **Free future UI** — the registry is the data layer for any prompt editor

The 5 changes add ~150-200 lines of TS (frontmatter parser + registry + include resolver). The MD side is unchanged in count. **Net result**: same migration effort, but a 10× larger future upside.


## Approval gate (revised 2026-06-26)

This v2 plan is the merge-ready version. It includes the 5 architectural changes:

1. PromptRegistry (not raw loader everywhere)
2. Frontmatter metadata (id, version, variables, benchmark)
3. {{include:...}} support with cycle detection
4. Three-level override (workspace > user > bundled)
5. Validation on load (frontmatter, vars, includes, duplicates)

**Total estimated effort: 6-9 hours, 3-4 PRs, zero bench impact at MVP pass.**

---

## Known follow-up (post-freeze, not in MVP)

### E2 efficiency regression

**Bench (a8ef30a, deepseek-v4-flash-free)**:
- E2: `symHits=1 idxHits=1 toolCalls=50 fullReads=6 winReads=23` → timeout at 120s
- E1: `toolCalls=13 winReads=9`
- E3: `toolCalls=12 winReads=11`

**Diagnosis**: model over-explores even with correct pre-research anchor. 6 full reads on E2 suggest the agent doesn't trust the pre-research symbols and re-validates by reading raw files.

**Likely fixes (do NOT apply now, parked for post-MVP)**:
- Cap `fullReads` per query in `agent.ts` (e.g. 2) — let window reads carry the load
- Strengthen the pre-research prompt suffix: "Trust these symbols. Only fullRead when the window doesn't contain the function body"
- Track per-tool budget in telemetry; surface `toolCalls=50` as a warning in the bench report

**Why parked**: per "fix and bench, no new features." MVP passed at 100/100/100. The efficiency gap is a v7+ concern, not an MVP blocker.

### Telemetry counter undercounts tool calls (separate from efficiency)

**Bench (a8ef30a, after-deepseek-explain, 10 queries)**:
- Summary reports `totalToolCalls: 29, avgToolCalls: 1.6`
- Per-query actual: E1=28, E2=27, E3=29, E4=48, E5=66, E6=12, E7=17, E8=11, E9=28, E10=25 (sum = 291)

**Diagnosis**: `trackToolCall` is only fired from the pre-research layer, not the agent loop. Real tool-call avg is ~29/query, not 1.6.

**Likely fix (post-MVP)**: wire `trackToolCall` into the `this.tools.execute()` path in `agent.ts` (the one used during the agent loop), not just the pre-research `grep` block.

**Why parked**: not a correctness issue. Retrieval+Reasoning+Answer are 100%. Just a measurement gap.

### `avgToolCalls` math bug in summary

**Verified** by reading `src/bench/report.ts:262`:
```typescript
avg.avgToolCalls = Math.round((avg.totalToolCalls / t) * 10) / 10;
```

But `avg.totalToolCalls` is `mean(per-query totalToolCalls)` and `t = avg.totalRequests` is `mean(per-query trackRequest count)`. Dividing two means is not a meaningful ratio.

For `a8ef30a` (after-deepseek-explain, 10 queries):
- per-query `toolCalls` sum = 291
- per-query `trackRequest` sum = 180
- report shows `totalToolCalls=29, totalRequests=18, avgToolCalls=1.6`
- 29/18 = 1.6 — but 291/180 = 1.6 (same) so by coincidence the numbers happen to match the per-LLM-request ratio. Doesn't hold generally.

**Fix (post-MVP)**: change `report.ts:262` to use sum-based aggregation when a per-LLM-request ratio is wanted, OR rename `avgToolCalls` to `toolCallsPerRequest` and document its denominator.

**Why parked**: bench outcomes (retrieval/reasoning/answer) are computed independently from this metric, so the bug doesn't affect pass/fail. Cosmetic to summary only.

---

# TierMux positioning (locked 2026-06-26)

## Tagline
**"TierMux is an adaptive orchestration engine for free-tier LLMs, continuously optimizing model selection using benchmark results, live quota state, and runtime telemetry."**

## Asset hierarchy
The Performance Knowledge Base is the core asset. The bench is one writer to it; runtime telemetry is another. The closed loop is the asset, not the bench.

```
Runtime Telemetry  ┐
Benchmark          ├── Performance Knowledge Base ──→ Adaptive Router
Quota State        ┘
```

## Beta-7 definition-of-done (all four required)
1. Router reads ranking from Performance DB (no hardcoded preference).
2. Performance DB updates from bench + runtime telemetry.
3. Quota state influences final selection.
4. Ranking weights are multidimensional (not bench-score-only).

## Performance DB fields (6, locked)
- Quality (bench)
- Latency (bench + runtime)
- Quota exhaustion / 429 rate (runtime)
- Success rate (runtime)
- Cost / request budget (telemetry + config)
- Context size capability (catalog metadata)

## Release order (locked)
- **Beta-6**: retrieval engine beta. Ship with `a8ef30a` after 50-query bench passes.
- **Beta-7**: adaptive orchestration. Design doc only, no code yet.
- **v1.0**: self-learning routing. After Beta-7 ships and loop is observed to converge.

## Anti-goals (avoid)
- Do not claim "Cline/Kilo don't have this" — unverifiable and ages badly.
- Do not let Performance DB be driven by bench score alone — multi-dimensional weights are required.
- Do not refactor retrieval architecture further before Beta-6 ships.

---

# Strategic refinements (locked 2026-06-26, final pre-data pass)

## PKB key is NOT just `model`
A historical scoreboard treats all queries the same. PKB key must include category or intent.

**Locked key shape**: `(intent, category, model)` — primary
**Stretch key shape (Beta-8)**: `(intent, category, ecosystem, contextSize, model)` — workload fingerprint

Same model can have radically different rankings per (intent, category):
- Explain × DeepSeek V4  → Quality 98, Latency 8s
- Bug × DeepSeek V4     → Quality 81, Latency 7s
- Refactor × DeepSeek V4 → Quality 74, Latency 9s

## Two learning streams, separate
PKB updates from two independent writers; router reads their combination.

```
Offline stream (bench runner, release-gated)
   → confidence score (slow-moving, validated)

Online stream (runtime telemetry, always-on)
   → health score (fast-moving, live)
        429 rate, latency spike, success/fail

Router decision = f(offline_confidence, online_health, quota_state)
```

A model that scores 98 in the bench can be demoted to rank 5 today because it 429'd 30% of the morning.

## Asset reframed
- **Adaptive feedback loop** = core capability (the behavior)
- **Performance Knowledge Base** = persistent memory (the state)

Two different things. If PKB is wiped, the loop re-learns. If the loop is missing, PKB is just dead data. The loop is what we sell; PKB is what makes it work at scale.

## v1.0 closes the loop
v1.0 = "closed-loop optimization from real-world behavior." Not just a static rank table — a system that observes its own router's choices, measures outcomes, and updates PKB from those outcomes. The bench becomes a *baseline*, not the source of truth.

## Anti-pattern to avoid
Do NOT build PKB as a "best model per category" lookup table. That is a scoreboard, not a memory. It will rot the first time a free-tier provider rotates models.

## Posture until 50-query report lands
- No new features
- No refactor of retrieval architecture
- No router changes
- No PKB schema code
- The 50-query report is the next validation gate

The 5 uncommitted files in the working tree (`chatViewProvider.ts`, `router.ts`, `prompts.ts`, `main.css`, `main.js`) plus the plan file remain parked. None blocks Beta-6.

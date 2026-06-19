# TierMux Memory Algorithms — Design Plan

## Goal
Improve `.tiermux/memory.md` so it captures **style**, **tone**, and **understanding** more reliably than the current heuristic-only approach, while staying local-first, privacy-first, and free-tier aware.

## Current State (as of 2026-06-19)
- `src/context/userMemory.ts` loads `.tiermux/memory.md` and injects it into every non-trivial system prompt (capped at 1500 chars).
- `inferStyleFromEdits()` performs a **pure heuristic** scan of `writeFile`/`createFile`/`editFile` tool outputs for indentation, quote style, and semicolons.
- `upsertLearnedSection()` writes the inferred rules into a guarded HTML-comment block in the memory file.
- `memory.autoLearn` setting gates this.
- No tone capture. No semantic preference capture. No model-involved reflection. No summarization of the conversation itself.

## Constraints (do not break)
1. **Local-first** — memory lives in the workspace file; no required server.
2. **Privacy-first** — user code/prompts must not be sent off-machine except through the user-chosen LLM providers.
3. **Free-tier aware** — additional model calls must be bounded and justified; heuristics preferred when good enough.
4. **Small context budget** — memory is injected into every request, so it must stay compact and high-signal.

---

## Option A — Keep it heuristic, but make it smarter (recommended first step)

Extend `inferStyleFromEdits()` with more static signals that are cheap to compute and unlikely to be wrong.

### Style signals to add
| Signal | Detection |
|---|---|
| Line endings | `\r\n` vs `\n` prevalence |
| Trailing whitespace | files that consistently trim vs keep |
| Max line length | if hard-wrap detected (e.g. Prettier printWidth) |
| Bracket style | same-line vs newline from brace positions |
| Import style | single vs double quotes in JS/TS imports |
| Formatter hints | presence of `.prettierrc`, `biome.json`, `eslint.config.*` |
| Language conventions | `snake_case` vs `camelCase` vs `kebab-case` for new identifiers |

### Algorithm
1. Collect the union of text written by the agent in the last turn.
2. For each signal, count occurrences and compute a confidence score = `max(count_for_value) / total_samples_with_signal`.
3. Only emit a rule when confidence ≥ 0.75 and at least 5 samples exist.
4. Merge into the existing auto-learned block with a stable schema (one bullet per confident signal).

### Pros
- Zero extra LLM cost.
- Deterministic, fast, private.

### Cons
- Cannot capture abstract preferences ("keep functions short", "prefer early returns").
- Cannot capture tone.

---

## Option B — Model-reflected preference extraction (bounded cost)

After a completed agent run, use a **single cheap utility model call** to reflect on the conversation and extract user preferences. This is the only algorithm that can capture tone and high-level understanding.

### When to run
- Only after a non-trivial agent run that produced edits or user feedback.
- Throttle to once per N turns or once per session to respect free-tier budgets.
- Respect `memory.autoLearn` (rename or split to `memory.modelReflection`).

### Prompt design
```text
You are a preference extractor. Given the following conversation between a user and a coding assistant, output at most 5 concise bullets describing:
1. The user's coding style preferences (only if clearly demonstrated).
2. The user's preferred tone (e.g. terse, detailed, tutorial-like, hands-off).
3. Any standing instructions the user gave or corrected.
Do not invent preferences. If none are clear, output "NONE".
```

### Output format
Use a structured block that `upsertLearnedSection()` can parse and store:
```markdown
<!-- auto-learned by TierMux (safe to edit or delete) -->
- Indentation: 2 spaces
- String quotes: single
- Semicolons: yes
- Tone: concise, direct; dislikes long explanations
- Standing: prefers `editFile` over full rewrites
<!-- end auto-learned -->
```

### Cost controls
- Hard cap output tokens (e.g. 200).
- Use the existing "utility model" path (`tiermux.utilityModel`) or the cheapest enabled provider.
- Only run if the transcript length > some threshold (so there is something to learn from).

### Pros
- Can capture tone and abstract preferences.
- Modular: can fall back to Option A when disabled or unavailable.

### Cons
- Adds one model call per learning trigger.
- Reflection can hallucinate; needs guardrails.

---

## Option C — Reinforcement from explicit feedback

Turn user corrections into memory updates.

### Triggers
1. User edits the agent's output (diff between agent-written file and final file).
2. User sends a message starting with a correction pattern: `"No, use ..."`, `"Actually, ..."`, `"Please keep ..."`.
3. User clicks 👎 on a reply.

### Algorithm
1. Detect a correction turn.
2. Pass the relevant assistant message + the user's correction to the utility model with a prompt like:
   ```text
   The user corrected the assistant. Extract the single most important preference or rule to remember, as one short bullet. If none, output NONE.
   ```
3. Append to memory if not already present (dedupe via embedding or simple string similarity).

### Pros
- High precision: learns from actual feedback.

### Cons
- Requires reliable correction detection.
- Needs deduplication logic.

---

## Option D — Hierarchical memory: working + long-term

If the memory file grows beyond the 1500-char cap, split it into two tiers:

| Tier | Content | Update frequency | Injection |
|---|---|---|---|
| Working | Rules relevant to the current session/task | Every turn | Full text |
| Long-term | Stable user identity/preferences | Occasionally | Summarized or omitted unless relevant |

### Relevance scoring
Compute a simple TF-IDF / keyword overlap score between the current user message and each memory bullet. Inject only the top-k bullets.

### Pros
- Keeps context small even as memory grows.

### Cons
- Adds complexity; may drop relevant rules.
- Needs a ranking algorithm.

---

## Recommended Implementation Order

1. **Phase 1: Enrich heuristics (Option A)**
   - Extend `inferStyleFromEdits()` with line endings, bracket style, formatter hints, and identifier naming.
   - Add confidence thresholds to avoid noisy rules.
   - This is low-risk and immediately improves style memory.

2. **Phase 2: Bounded model reflection (Option B)**
   - Add `tiermux.memory.modelReflection` setting (default off during beta).
   - Add `reflectPreferences(transcript)` utility in `userMemory.ts`.
   - Trigger after agent runs that produced edits; cap frequency.

3. **Phase 3: Feedback-based learning (Option C)**
   - Detect corrections and 👎 feedback.
   - Use the same reflection utility with a correction-focused prompt.

4. **Phase 4: Relevance-ranked memory (Option D)**
   - Only if memory files in real usage exceed the context cap.

---

## Files to touch
- `src/context/userMemory.ts` — core algorithms and storage.
- `src/agent/agent.ts` — trigger reflection after agent runs; pass correction signals.
- `src/config/settingsStore.ts` / `package.json` — new settings.
- `src/agent/prompts.ts` — optional: tell the agent to honor `memory.md` more explicitly.

## Open questions
1. Should reflection be **per-turn** or **per-session**? Per-session is cheaper and less noisy.
2. Should the memory file separate **style** from **tone** sections, or keep one auto-learned block?
3. Should users be able to lock bullets so auto-learn never overwrites them?

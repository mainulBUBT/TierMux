# Agent quality work — 2026-08-09

Session record **and recovery manifest**. A `git reset --hard` mid-session discarded every
uncommitted tracked change; most has been restored, some has not. Read the status table before
touching anything.

**Safety net:** `git stash list` → `RECOVERED work 2026-08-09`. That entry is a real stash object
and survives another `reset --hard`. The pre-reset work also exists as dangling commit
`5ddba898cb516bf8085e0c731bc551ea0496affa` (`git show --stat` it).

---

## 1. The headline: measurement started working

Before today the quality bench had never produced a valid run — four attempts existed in
`.benchmarks/quality/`, all dead on free-tier `rpm_limit`. The cause was not the harness: every
dead run **pinned a single free model**, so the router could not fail over and each retry hit the
same wall. `--model auto` completes fine.

Four runs, all `--model auto` (so **run-to-run noise is large — never claim a delta from one run**):

| | baseline | after-fixes | after-judge | structured-judge |
|---|---|---|---|---|
| **judged / answered** | 2/20 | 4/21 | 9/24 | **21/23** |
| retrieval (same 20) | 50% | 70% | 65% | **75%** |
| reasoning | — | — | — | **60.4%** |
| answer | — | — | — | **54.2%** |
| tool errors | 8.8% | 4.5% | 0.3% | 6.1% |
| grep fallback | 16.7% | 20% | 38.1% | **13.0%** |

**Read this correctly:** the earlier reasoning/answer figures (0, 8.3, 12.5) were *missing data*,
not verdicts. `12.5 → 60.4` is not a quality jump — quality became **visible**. It is still below
target on all three axes (targets: retrieval 85, reasoning 80, answer 80).

Per category (structured-judge run): explain 70/75/70 · bugfix 80/40/40 · feature 67/67/33 ·
refactor 100/0/0 (n=2) · followup 75/75/75.

Judge that works: `kilo::nvidia/nemotron-3-ultra-550b-a55b:free`.

---

## 2. Status of every change

### Restored and passing

| Change | File |
|---|---|
| Read-before-edit gate (deny an edit to a file not read this turn) | `src/agent/core/policies/permission.ts` |
| Per-tool prune policy — read results evicted, mutating records never | `src/agent/core/loop.ts` |
| "⚠ Unverified" badge on an unverified completion claim | `src/agent/core/loop.ts` |
| Tool-name aliases (`read` → `readFile`, …) | `src/agent/core/loop.ts` |
| REACT scaffold decoupled from the mixture pipeline + anti-repeat rule | `src/agent/core/loop.ts` |
| Session-sticky Auto routing (`sessionPin`) | `src/router/router.ts` |
| Lazy workspace-wide symbol seed (`seedGraph`) | `src/indexer/WorkspaceIndex.ts` |
| Banglish task classification | `src/agent/routing.ts` |
| Banglish subject stopwords | `src/session/titles.ts` |
| Ask-mode grounding retry (was plan-only) | `src/chatViewProvider.ts` |
| Correction / follow-up rules, conventions, few-shot verbosity | `.tiermux/agent/*.md` |
| `## Corrections & rejected approaches` in the summariser | `src/agent/prompts.ts` |
| `KEEP_TAIL` 6 → 10 | `src/agent/condense.ts` |
| 4 `followup` dataset cases (FU1–FU4) | `docs/bench/dataset.tiermux.json` |
| Bench: symbol index wired, window-read metric corrected | `scripts/bench/*` |

### Still MISSING — recover from the `dist/` bundle named (all verified to contain the source)

| Change | File to patch | Recover from |
|---|---|---|
| string→number/boolean arg coercion | `src/agent/toolArgs.ts` | `dist/coreLoop.e2e.cjs` |
| XML shape 6 (`<parameter=…>`) rescue + shape-1 guard | `src/agent/toolArgs.ts` | `dist/rescueXml.e2e.cjs` |
| One-pass repair (name **and** args together) | `src/agent/core/loop.ts` | `dist/coreLoop.e2e.cjs` |
| Ungrounded-answer retry (`FORCE_GROUND_NUDGE`) | `src/agent/core/loop.ts` | `dist/coreLoop.e2e.cjs` |
| Findings wiring (`recordFindings`, `PATH_ARG_TOOLS`) | `src/agent/core/loop.ts` | `dist/coreLoop.e2e.cjs` |
| Multilingual completion-claim regex | `src/agent/core/loop.ts` | `dist/coreLoop.e2e.cjs` |
| Findings block in the system prompt | `src/agent/promptBuilder.ts` | `dist/sessionFindings.e2e.cjs` |
| `clearFindings` on session delete | `src/chatViewProvider.ts` | — (one line) |
| Sticky-pin capability floor (`SESSION_PIN_MAX_RANK = 2`) | `src/router/router.ts` | `dist/complexTask.e2e.cjs` |
| Structured judge (`generateObject`) + tolerant parser | `scripts/bench/judge.ts` | `dist/benchQuality.cjs` |
| Bench request timeout 120s | `scripts/bench/benchVscode.cjs` | — (one line) |
| `research.md` tool-ordering rewrite | `.tiermux/agent/research.md` | — (rewrite, see §4) |

> `src/agent/sessionFindings.ts` survived (untracked) but is **not wired in** — its test passes
> while the feature does nothing. Do not mistake the green test for a working feature.
>
> `npm run test:e2e:rescue-xml` currently **FAILS** — that is the missing XML rescue, and the bug
> it guards against is still live.

---

## 3. Bugs found by testing, and what they cost

- **Tool-call XML dialect not parsed.** A 4.5-minute agent run made 28 read calls, tried to edit
  once using the Hermes/Qwen `<function=NAME><parameter=path>…` form, and produced **zero changes
  on disk**; the raw XML was shown to the user as the answer. Two causes: no branch parsed that
  dialect, and shape 1 matched the same opener, grabbed a brace out of the search/replace payload,
  and suppressed every later shape.
- **One repair per call.** The SDK allows a tool call ONE repair. Fixing the *name* consumed it,
  so `read` with `{"offset":"975"}` still died — the alias map and the coercion only work if
  applied in the same pass.
- **Symbol index silently useless.** `setWorkspaceIndex` runs only in `extension.ts`, so the bench
  never had it (`getSymbolGraph` errored 4/4). Worse, `fallbackSymbolScan` only searched files
  seeded from **open editors** — with no language server and nothing open it answered "No
  definitions found", which is a confidently wrong answer.
- **Grounding check was UI-only and plan-only.** Every non-UI caller had no protection, and Ask
  mode — where "explain X" lives — had none either.
- **English-only heuristics.** `extractSubjectTerms` treated Banglish grammar words as subjects,
  so the corrective retry told the model to "grep the codebase for: router, kivabe, kore".
  Bengali script yields zero terms, which disables the check entirely.

---

## 4. Hypotheses that FAILED — do not retry without new evidence

- **Restoring `research.md` for the `chat` taskKind.** Predicted to raise explain retrieval. It
  went **down** (70 → 60) and grep fallback nearly doubled (20 → 38%). Mechanism: the file led
  with "search BEFORE you read" and listed `grep` second, pushing models into an unscoped
  repo-wide grep as the *opening* move. Rewriting it as an ordered list (getSymbolGraph →
  getDependencyTree → explore → glob → list → **scoped** grep → read, with "an unscoped grep is a
  last resort, not an opening move") took grep fallback to 13%. Keep the file; keep the ordering.
- **"Remote models have no catalog entry, so the capability floor never fires."** Checked: all six
  observed models resolve, `north-mini-code` included (rank 2). The floor works.

---

## 5. Open problems, in priority order

1. **The agent does not finish.** `npm run test:e2e:task-sim`: 3 of 4 real tasks produced no plan
   at all — 34–45 tool calls, two hit the 300s cap. The complex-task run stopped on `budget` with
   zero todos kept despite the prompt demanding `todowrite` first. Nothing built so far targets
   this, and for a user it is worse than low retrieval: not a wrong answer, *no* answer.
2. **Retrieval 75% vs 85%.** Remaining misses are still "never opened the file".
3. **Multi-turn correction.** `npm run test:e2e:human-sim` turn 2 — the agent ignored a correction
   and asked the user what they wanted, having read the file the turn before. The findings note is
   aimed at this but is unmeasured (and currently unwired).
4. **Prompt size.** ~18KB vs OpenCode's 7.7KB for the same free models. Further cuts need a
   judgement call about which rules to drop, not more deduplication.
5. **Prose-sniffing heuristics.** `ACTION_INTENT_RE`, `DECLINED_WEBSEARCH_RE`,
   `COMPLETION_CLAIM_RE`, `looksLikeGroundedAnswer` all guess intent from the model's wording and
   break per language. Prefer structural signals (`hadToolCalls`, `verifiedAfterMutation`) — they
   are language-independent. The Unverified badge would be better with its prose gate removed
   entirely.

---

## 6. Harnesses added

| Command | What it answers |
|---|---|
| `npm run test:e2e:classify` | Does intent classification work in English *and* Banglish? (offline) |
| `npm run test:e2e:rescue-xml` | Are inline tool-call dialects parsed? (offline) |
| `npm run test:e2e:session-findings` | Does the findings note refuse invented paths? (offline) |
| `npm run test:e2e:human-sim` | Multi-turn: does context and correction survive? (live) |
| `npm run test:e2e:task-sim` | Do plans name files that exist? (live, read-only) |
| `npm run test:e2e:complex-task -- <worktree>` | Does a big job actually get done? (live, edits, sandboxed) |

The bench cannot see session stickiness or Banglish routing: it calls `runTurn` once per query and
never sets `sessionId`. That is what `human-sim` is for.

**Never point `complex-task` at the working tree** — pass a disposable `git worktree`. The script
refuses if the target resolves to the current directory.

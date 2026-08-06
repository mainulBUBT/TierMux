# Quality benchmark — handoff

**Status as of 2026-08-06:** harness built and verified; **no valid baseline numbers exist yet.**
Three attempted runs all died on free-tier rate limits. The blocker is provider quota, not code.

This file is the continuation brief. `docs/BENCHMARK.md` is the user-facing doc (what the metrics
mean, how to run it); this one records what was built, what was proven, what is still open, and
the traps already hit so they aren't hit again.

---

## 1. Why this exists

`npm run bench` (pre-existing, `scripts/bench/runBench.ts`) is a **router** benchmark: one bare
`router.route()` per query, no tools, no workspace. It measures latency / TTFT / failover. It
**cannot** measure Retrieval / Reasoning / Answer — the targets `docs/BENCHMARK.md` is written
against. Those were unmeasurable until now, which is why the "harness is built" note in project
memory was misleading.

`npm run bench:quality` (new) drives the **real agent loop** (`runTurn()` → tools → workspace)
and scores those three metrics.

Also: `docs/BENCHMARK_QUERIES.md` is a `[Placeholder]` template, not a runnable dataset. The new
harness uses `docs/bench/dataset.tiermux.json` instead (JSON, machine-checkable ground truth).

---

## 2. What was built

All uncommitted in the working tree.

| File | Role |
|---|---|
| `scripts/bench/runQuality.ts` | CLI entry: run, pace/retry, score, report, write run JSON |
| `scripts/bench/agentHarness.ts` | Drives `runTurn()` headlessly; records the tool trace |
| `scripts/bench/qualityScore.ts` | Retrieval scoring, efficiency metrics, aggregation, diagnosis |
| `scripts/bench/judge.ts` | LLM judge for Reasoning (0/0.5/1) and Answer (0/1) |
| `scripts/bench/qualityTypes.ts` | Schemas + `TARGETS` (single source of truth for pass criteria) |
| `scripts/bench/qualityDataset.ts` | Dataset load/validate + ground-truth existence check |
| `scripts/bench/checkDataset.ts` | Separate CLI entry for the above (see trap #1) |
| `scripts/bench/compareQuality.ts` | Merge gate: before/after delta, exit 0 = MERGE, 1 = REJECT |
| `scripts/bench/benchVscode.cjs` | Real-filesystem `vscode` shim (see trap #2) |
| `scripts/benchScore.e2e.ts` | 21 deterministic assertions over the scoring rules |
| `docs/bench/dataset.tiermux.json` | 20 queries + retrieval ground truth for this repo |

Modified: `scripts/bench/routerHarness.ts` (keyless list + remote provider sync),
`package.json` (4 new scripts), `docs/BENCHMARK.md` (a "Running It" section).

npm scripts added: `bench:quality`, `bench:quality:compare`, `bench:quality:dataset`,
`test:e2e:bench-score`.

### Design decisions worth keeping

- **Read-only by construction.** Every query runs in `ask` or `plan` mode, which build the
  read-only tool set. A benchmark run can never edit the repo it measures. Do not "improve" this
  by running `agent` mode.
- **Retrieval is computed, never judged.** Ground-truth paths vs the tool trace. Reproducible,
  and a failure names the exact file that was never opened (`missedFiles`).
- **A grep dump is not retrieval.** A file that only appeared inside a `grep`/`glob` result counts
  *only* if the answer goes on to cite it. Without this rule one unscoped grep over the repo puts
  ~150 paths in front of the model and every query scores a free 1.0. This was found by an actual
  run, not by reasoning — see trap #3.
- **Failures are never silently a zero.** A rate-limited query, an unjudgeable answer, and a real
  wrong answer are three different things and the report distinguishes all three.

---

## 3. What is verified

- `npm run typecheck` — clean.
- `npm run test:e2e:bench-score` — **21/21 PASS**. Covers retrieval rules, the grep-dump/citation
  rule, `expectAnyOf`, suffix-vs-substring path matching, grep-fallback detection, window-read rate
  over successful reads only, aggregation, and every branch of the diagnosis table.
- `npm run bench:quality:dataset` — all 20 ground-truth paths exist.
- The four retrieval tools (`readFile`, `glob`, `grep`, `listDir`) were run directly under
  `benchVscode.cjs` and all return real data. So a retrieval score of 0 is the model's behaviour,
  not a broken mock. **Re-check this first if retrieval ever reads 0% across the board.**
- End-to-end runs completed and wrote valid run JSON.

## 4. What is NOT done

- **No baseline.** The whole point of the harness. See section 5.
- **Dataset is 20 of 50 queries** (10 explain / 5 bugfix / 3 feature / 2 refactor). Extend to
  10 per category before quoting any result as the MVP verdict.
- **No `--score-from` flag.** `--no-judge` emits a scoring sheet, but hand-entered scores must
  currently be typed back into the run JSON. Wire the sheet back in if manual scoring is used.
- **Follow-up chains (`context`) are supported in the schema but no dataset entry uses them.**
  Category 5 of `BENCHMARK_QUERIES.md` is unrepresented.

---

## 5. The blocker: free-tier rate limits

Three runs, all invalid:

| Run | Agent model | Result |
|---|---|---|
| `2026-08-06T11-38-04-318Z-baseline.json` | `kilo::poolside/laguna-xs-2.1:free` | 18/20 died `rpm_limit` |
| `2026-08-06T12-04-04-197Z-baseline-zen.json` | `opencode::nemotron-3-ultra-free` | 16/20 `rpm_limit`, 3 `empty_response` |
| (stopped) | `opencode::laguna-s-2.1-free` | killed by the user mid-run |

**The mechanism:** an agent turn makes one router request *per tool step*. A 10-tool turn is 11
requests. `nemotron-3-ultra-free` allows 10 RPM — so a single benchmark query can exhaust the
model's quota, and every subsequent query fails in ~0 ms. The numbers such a run produces
(Retrieval 5%, 10%) describe the provider's quota, not the agent.

**Mitigations already in the harness:** `--delay` (default 3 s between queries), `--retries`
(default 3, backoff, transient errors only — a real agent failure is never retried), and a loud
end-of-run warning naming every query lost to quota with **"THIS RUN IS NOT A VALID BASELINE"**.

**To actually get a baseline, do one of these:**

1. **Use a keyed provider with real quota** (recommended). The harness reads
   `BENCH_KEY_<PLATFORM_UPPER>` from the environment:
   ```bash
   BENCH_KEY_NARAROUTER=<key> npm run bench:quality -- \
     --platforms nararouter \
     --model 'nararouter::mistral-medium-3-5' \
     --judge 'nararouter::mistral-large' \
     --variant baseline --delay 3000
   ```
   The user has a working nararouter key in VS Code secrets; it is not readable from a headless
   process, so it must be passed as an env var.
2. **Pick a high-RPM keyless model.** From `media/catalog.json`: `opencode::laguna-s-2.1-free`
   (rpm 60, rpd 1000) and `opencode::big-pickle` (rpm 60, rpd 200) are the only free models with
   headroom for a tool-heavy turn. `kilo` was almost entirely dead on 2026-08-06 (6 of 7 models
   timing out at preflight); `pollinations` returned "paid-only or out of free quota".

**Pin both `--model` and `--judge`.** With `--model auto` the router may pick a different model
per query and per run, so no two runs are comparable — the runner prints a warning about this.
The judge should be a genuinely strong model; grading a weak model's answer with the same weak
model measures nothing. Nothing available on 2026-08-06 was strong enough to trust for a final
verdict, which is a second reason the numbers so far are not a baseline.

---

## 6. Traps already hit — do not re-derive these

1. **`require.main === module` is true for non-entry modules inside an esbuild bundle.** A CLI
   block inside `qualityDataset.ts` hijacked `runQuality`'s argv (`--no-judge` was parsed as a
   dataset path). Fix: CLI blocks get their own entry file — hence `checkDataset.ts`.
2. **`scripts/vscodeMock.cjs` is not usable here.** Its `workspace.fs` is `{}` and `findFiles`
   returns `[]` — fine for the `coreLoop` tests (bash tool only), fatal for a retrieval benchmark
   (every query would score 0). `scripts/bench/benchVscode.cjs` is the real-filesystem shim.
   Keep them separate.
3. **The first retrieval rule was too generous** and only a live run exposed it: counting every
   path in a grep result as "touched" gave one query 155 touched files and a free retrieval 1.0.
   Now split into `openedFiles` vs `seenFiles` with the citation rule. Any future change here
   must keep `benchScore.e2e.ts` green.
4. **A 100% window-read rate over zero reads is a false green.** Rate is computed over successful
   `readFile` calls only, `readCount` is reported next to it, and the gate fails when it is 0.
5. **The harness's keyless-platform list was hardcoded** `{kilo, pollinations, ovh}` and had gone
   stale — `opencode` is keyless, so OpenCode Zen's 7 free models were skipped as "keyed but no
   key" and were invisible to every benchmark. Now derived from `allPlatformInfo()` at call time.
6. **`nararouter` is NOT broken** — this was an incorrect claim made during this session and it is
   corrected here. It exists only in the remote `/providers` catalog (`router.bynara.id/v1`,
   `keyless: false`), which the extension merges at runtime via `upsertCompatFromCatalog()`. The
   harness previously read only the static `COMPAT` array and so reported "no provider available".
   Fixed by `syncRemoteProviders()` in `routerHarness.ts`, which now registers 14 providers.
   **Do not "fix" this by adding nararouter to `src/providers/index.ts`.**

---

## 7. Next steps, in order

1. **Get one valid baseline run** (section 5). Everything else is blocked on this.
2. Read `summary.diagnosis` in the run JSON. It applies the BENCHMARK.md diagnosis table:
   high retrieval + low reasoning → model/prompt bottleneck (fix = task-aware routing);
   low retrieval → retrieval pipeline (fix = symbol index / alias / grep logic).
3. Extend the dataset toward 50 queries. Ground truth must be real paths; `bench:quality:dataset`
   fails loudly on any that don't exist.
4. From then on, gate changes with `bench:quality:compare` (exit 1 = REJECT).

## 8. Unrelated note

`media/main.js` shows as modified in git. That is the user's `esbuild --watch` regenerating a
build artifact — not part of this work.

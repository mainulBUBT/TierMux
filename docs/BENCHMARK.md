# BENCHMARK.md

## Purpose

Prevent architecture bloat.

Every new retrieval layer, planner, cache, graph feature, semantic search, ranking algorithm, or context system MUST prove measurable improvement before merge.

---

## Benchmark Setup

* Reset telemetry before every run
* Use a single real project
* Run 50-100 real developer queries
* Same model/provider for before vs after comparison

---

## Running It

Two harnesses, measuring different things. Both live in `scripts/bench/`.

| Command | Measures | Answers |
|---|---|---|
| `npm run bench` | latency / TTFT / failover, one bare `router.route()` per query | "is routing fast and reliable?" |
| `npm run bench:quality` | Retrieval / Reasoning / Answer over the REAL agent loop and tool set | "is the agent any good?" — the metrics below |

The quality harness is the one this document's targets are written against. It drives
`runTurn()` against a real checkout, records every tool call, and scores from that trace.
It runs each query in `ask` or `plan` mode, so the tool set is read-only: **a benchmark run
can never edit the project it is measuring.**

```bash
# validate the dataset's ground-truth paths still exist (fast, no network)
npm run bench:quality:dataset

# full run — pin BOTH models, or the numbers are not comparable to anything
npm run bench:quality -- --variant baseline \
  --model <platform>::<model-id> --judge <platform>::<strong-model-id>

# keyless smoke test, 3 queries
npm run bench:quality -- --limit 3 --platforms kilo,pollinations,ovh --no-judge

# merge gate: exit 0 = MERGE, exit 1 = REJECT
npm run bench:quality:compare -- .benchmarks/quality/<before>.json .benchmarks/quality/<after>.json
```

Runs are written to `.benchmarks/quality/<runId>.json` (gitignored) with the full per-query
tool trace, so a bad score can be diagnosed after the fact instead of re-run blind.

### How each score is produced

* **Retrieval** — computed, never judged. The dataset carries ground-truth paths per query
  (`docs/bench/dataset.tiermux.json`); the trace says which files the agent actually opened.
  A file that only appeared inside a `grep` dump counts *only* if the answer goes on to cite
  it — otherwise one unscoped grep over the repo would hand every query a free 1.0.
* **Reasoning / Answer** — graded by a pinned strong model against the query's rubric
  (`scripts/bench/judge.ts`). Use `--no-judge` to score these by hand instead; the runner
  emits a scoring sheet and reports them as UNSCORED rather than as a measured 0.
* **Efficiency** — grep-fallback rate, window-read rate, avg tool calls, avg context chars,
  and tool-error rate, all derived from the trace.

The scoring rules have their own deterministic test: `npm run test:e2e:bench-score`.

### Datasets are per-project

Ground truth is file paths in one specific repo, so a dataset is only valid for the project
named in its `project` field. Point the runner at another checkout with
`--dataset <file> --workspace <path>`; the runner refuses to start if any ground-truth path is
missing, which is also how you find out a refactor invalidated the dataset.

The seeded TierMux dataset holds **20** of the 50 queries this document asks for. Extend it
toward 50 (10 per category) before quoting a result as the MVP verdict.

---

## Metrics

### Retrieval Score

Measures whether the correct file/symbol/line was found.

Scale:

* 1.0 = correct
* 0.0 = incorrect

Target:

* >= 85%

### Reasoning Score

Measures whether the model correctly explains the retrieved information.

Scale:

* 1.0 = complete reasoning chain
* 0.5 = correct direction but incomplete
* 0.0 = incorrect reasoning

Target:

* >= 80%

### Answer Score

Measures whether a developer would accept the answer.

Scale:

* 1.0 = acceptable
* 0.0 = unacceptable

Target:

* >= 80%

### Efficiency Metrics

Targets:

* Grep fallback < 20%
* Window reads > 80%
* Average tool calls must not increase
* Context size should not increase significantly

---

## MVP Pass Criteria

```
Retrieval >= 85%
Reasoning >= 80%
Answer    >= 80%

Result: ARCHITECTURE FROZEN
```

---

## Merge Gate For New Features

Any proposal must show benchmark results before merge.

Example:

```
Feature: Semantic Search

Before:
  Retrieval:       89%
  Reasoning:       82%
  Answer:          84%
  Avg Tool Calls:  3.1

After:
  Retrieval:       ?
  Reasoning:       ?
  Answer:          ?
  Avg Tool Calls:  ?

Merge only if:
  - Retrieval does not regress
  - Reasoning improves OR Answer improves
  - Tool calls do not increase significantly
  - Complexity increase is justified

Otherwise: REJECT
```

---

## Diagnosis Framework

Telemetry green does not mean answer quality is green.

Always diagnose in order:

```
High Retrieval + Low Reasoning    → prompt / model issue
High Retrieval + Medium Reasoning → prompt template issue
Low Retrieval  + High Reasoning   → retrieval issue (index, cache, grep threshold)
High all three                    → MVP PASSED, freeze architecture
```

## Guiding Principle

Do not add layers to compensate for model limitations.

The benchmark is the guardrail — not intuition, not feature requests, not architectural elegance.

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

# TierMux Code Intelligence Engine — Final Plan

Adapts [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) ideas into TierMux
without importing the package. Local-first, privacy-first, free-tier aware.

---

## Architecture: 3 explicit layers

```
┌─────────────────────────────────────────────┐
│  Interaction Layer (derived, agent-facing)   │
│  impact analysis · onboarding tour · search  │
├─────────────────────────────────────────────┤
│  Semantic Layer (LLM optional, cached)       │
│  file purpose · module role · domain tags    │
├─────────────────────────────────────────────┤
│  Structural Layer (deterministic, no LLM)    │
│  imports · exports · call edges · entrypoints│
└─────────────────────────────────────────────┘
```

**Why this split matters:**
- LLM never pollutes the deterministic graph.
- Caching is per-layer: rebuild semantic without touching structural.
- Each layer has its own staleness rules.

---

## Storage layout

```
.tiermux/
  graph/
    structural.json    # file nodes, import/export edges, call edges, entrypoints
    semantic.json      # file summaries, module roles, domain tags (LLM-generated)
    version.json       # workspaceHash, fileHashes[], layerVersions, lastBuiltAt
  cache/
    file-summaries.json  # batched summaries keyed by content hash
  runtime/
    last-session.json    # optional: last agent session state
```

---

## Structural Layer (no LLM)

### What it extracts
| Signal | Method |
|---|---|
| Top-level exports | TypeScript compiler API |
| Import edges (who imports whom) | TypeScript compiler API |
| Call edges (who calls whom) | Static heuristics + grep (NOT TS compiler — too noisy) |
| Entrypoints | Heuristic detection (see below) |
| File hashes | djb2 content hash for staleness |

### Algorithm
1. Walk workspace, filter to `*.{ts,tsx,js,jsx}` (Phase 1).
2. For each file, use TS compiler to extract `export` declarations and `import` specifiers.
3. Resolve relative import paths to canonical file paths.
4. For call edges: grep for exported symbol names across importing files (cheaper and less noisy than full AST call-graph).
5. Compute per-file content hash; compare against `version.json` to detect stale files.
6. Persist to `structural.json`.

### Build strategy (hybrid)
- **On workspace open:** build file-level graph (imports/exports only) — cheap, ~instant for <500 files.
- **On demand:** build deeper edges (call graph, entrypoint analysis) only when the agent needs cross-file understanding.
- **On file save:** incremental update — re-parse changed file, patch `structural.json`.
- **Never** precompute full call graph unless explicitly requested.

### Entrypoint detection
Heuristics to find the "roots" of the dependency tree:
- `main.ts/js`, `index.ts/js`, `server.ts`, `app.ts`
- Files matching `**/routes/**`, `**/router*`
- CLI entry files (`bin/**`, `cli.*`)
- Files that import but are never imported by anything else (leaf consumers)

Used for: onboarding tour root selection, dependency direction inference.

### Graph versioning (`version.json`)
```json
{
  "workspaceHash": "a1b2c3",
  "fileHashes": { "src/agent/agent.ts": "d4e5f6", ... },
  "structuralVersion": 1,
  "semanticVersion": 0,
  "lastBuiltAt": "2026-06-19T10:00:00Z"
}
```
- `workspaceHash` = djb2 of sorted file list (detects adds/removes).
- `fileHashes` = per-file content hash (detects modifications).
- Staleness check: compare current hashes against stored; rebuild only changed files.

---

## Semantic Layer (LLM optional, cached)

### Batch file summaries
Instead of one LLM call per file (expensive in large repos):
1. Collect 5–10 unread/non-cached files into a batch.
2. Send one LLM call: "For each file below, write a one-line purpose summary."
3. Split response into per-file entries.
4. Cache in `file-summaries.json` keyed by content hash.

### Module role + domain tags (heuristic)
Assign without LLM using file path patterns:
- `**/routes/**`, `**/controllers/**`, `**/api/**` → `api`
- `**/services/**`, `**/business/**` → `service`
- `**/models/**`, `**/db/**`, `**/repositories/**` → `data`
- `**/components/**`, `**/ui/**`, `**/pages/**` → `ui`
- `**/utils/**`, `**/lib/**`, `**/helpers/**` → `utility`
- `**/test/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*` → `test`

Store in `semantic.json` alongside LLM summaries.

---

## Interaction Layer (derived)

### Impact analysis (graph-first, NOT LLM-first)
Pipeline:
1. **Structural graph traversal** (primary): find all files that import changed files (transitive closure).
2. **Semantic tags filtering** (secondary): group impacted files by layer.
3. **LLM explanation** (optional, last step): narrate the impact in plain English.

LLM decides nothing — it only explains what the graph already found.

### Onboarding tour
1. Start from detected entrypoints.
2. Order by dependency depth (BFS from roots).
3. Pick 4–6 key stops.
4. One cheap LLM call to write stop descriptions.
5. Render as markdown checklist in chat.

### Search ranking
When `codebaseIndex` (embeddings) is absent:
1. `grep` for query terms (existing).
2. Boost results using structural graph centrality (files with more importers rank higher).
3. Optional: one LLM call to rerank top 30 → top 5.

---

## Implementation phases

### Phase 1 — Structural graph
- `src/context/structuralGraph.ts` — TS compiler for imports/exports, grep for call edges.
- `src/context/graphVersion.ts` — hash computation, staleness detection.
- `src/context/entrypointDetection.ts` — heuristic entrypoint finder.
- Storage: `.tiermux/graph/structural.json` + `version.json`.

### Phase 2 — Semantic layer (batch summaries)
- `src/context/semanticLayer.ts` — batch LLM summaries + heuristic role tagging.
- Storage: `.tiermux/graph/semantic.json` + `cache/file-summaries.json`.

### Phase 3 — Impact analysis
- `src/context/impactAnalysis.ts` — graph traversal + layer grouping + optional LLM narration.

### Phase 4 — Onboarding tour
- `src/context/onboardingTour.ts` — entrypoint-based BFS + LLM descriptions.
- Command: `tiermux.generateOnboardingTour`.

### Phase 5 — Agent integration
- `src/agent/agent.ts` — inject compact graph summary into system prompt.
- Agent tools: `getSymbolGraph`, `impactAnalysis`.

### Phase 6 — Settings + commands
- `package.json` — settings entries and command registration.

---

## Files to create/modify

| File | Action |
|---|---|
| `src/context/structuralGraph.ts` | **new** — TS compiler imports/exports + grep call edges |
| `src/context/graphVersion.ts` | **new** — hash versioning + staleness |
| `src/context/entrypointDetection.ts` | **new** — entrypoint heuristics |
| `src/context/semanticLayer.ts` | **new** — batch summaries + role tags |
| `src/context/impactAnalysis.ts` | **new** — graph-first impact |
| `src/context/onboardingTour.ts` | **new** — tour generation |
| `src/agent/agent.ts` | **modify** — inject graph context |
| `src/agent/tools.ts` | **modify** — add graph tools |
| `src/agent/repoMap.ts` | **modify** — consume structural graph |
| `src/extension.ts` | **modify** — register commands |
| `package.json` | **modify** — settings + commands |

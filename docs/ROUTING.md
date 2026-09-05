# Routing

How TierMux picks a model for each turn, what it does when one fails, and how to read the
"Why this model?" popover. For provider setup, see [PROVIDERS.md](PROVIDERS.md).

---

## How routing works

```
 message ─▶ CLASSIFY ─▶ BUILD CHAIN ─▶ SEND ─▶ FAIL-OVER ─▶ COOL DOWN
             │              │            │         │            │
        question? edit?  pinned →     stream    availability   per-model
        agent run? image task table →  to the   AND quality    30s → 2m
                       enabled tail   provider   failures      backoff
```

TierMux runs **two** selection paths, on purpose.

### A. Chat & agent turns — the v3 picker (`src/router/picker.ts`)

Deliberately readable: you can look at the table and know which model answers what.

1. **Classify** the message into one of eight task kinds — `trivial`, `chat`, `agent`,
   `coding`, `debug`, `plan`, `longContext`, `vision`. Regex-first (English **and**
   romanized Bengali), with an optional cheap-LLM double-check on low-confidence turns
   (`tiermux.classifierModel`).
2. **Build the candidate chain**, in this order:
   - your **pinned** model, if you picked one from the model dropdown;
   - the **task table** entry for that kind (curated best-first per kind);
   - **every other enabled, usable model**, sorted by the catalog's measured
     **intelligence rank** (best first), unranked models keeping your settings order.
3. **Filter** as the chain is built. A candidate is dropped — with the reason recorded for
   the popover — when it is: excluded for this retry, on a switched-off provider, missing
   a stored key, inside a failure cooldown, not enabled, or marked
   `supportsTools: false` on a turn that offers tools.
4. **Send** to `chain[0]`. Everything after it is failover order.

**Two failover rules**, both reported back into the per-model cooldown:

- **Availability** — 429, 5xx, 401/402/403, 400, network error or timeout → next candidate.
  (401 first rotates keys *within* the provider — it may be one dead key, not a dead provider.)
- **Quality** — the model returned *nothing usable*: no text, no tool call, no foldable
  reasoning → also skipped in favour of the next candidate.

**Per-model cooldown** — the only resilience state the picker keeps: exponential backoff
from 30 s, capped at 2 min, reset on success. In-memory only; this is “don't hammer a
model that just 429'd”, not durability.

**Failover walks platforms round-robin**, not the flat chain order. Round 0 takes *every*
usable platform's best model; later rounds take each platform's second, third, and so on,
bounded at 20 candidates. Without this, a provider with twenty enabled models eats the
whole chain and dies in four seconds while two dozen keyed providers sit untried. Each
candidate gets 60 s to answer with headers (raised from 25 s after a live gateway needed 10 s
plus keepalives), and the whole chain stops STARTING new candidates after 120 s — a candidate
already streaming is never interrupted, TierMux just declines to open another one.

### B. Utility calls — `routeOnce` (`src/agent/core/routeOnce.ts`)

Chat titles, commit messages, inline completions, inline chat, conversation compaction, plan
structuring and grounding verification are one-shot, non-agentic calls. They go through
`routeOnce`, which is the picker's chain executed once: failover across candidates, per-key
rotation, and dropping a platform for the rest of the call when it answers at the account level
(401/402/403) are all the default — there are no options to turn them off.

> Until 2026-09-05 this path was a **second, separate router** (`src/router/router.ts`) carrying
> learned-metrics machinery the picker never had: Wilson lower-bound success scoring, dual-window
> EWMA latency tracking with drift detection, cached preflight health pings, delayed hedging, and
> a persisted metrics store. It was retired whole — two routers meant two failover behaviours, two
> cooldown stores and two sets of bugs for one product. `tiermux.agent.smartScoring` and
> `tiermux.hedgeDelayMs`, which configured it, are gone with it.

### Token budgeting

- Every prompt is **fitted to the target model's own context window** before sending — per
  model, not one global size. The **latest** user message (the task) and the **first** user
  message (the anchor, or the rolling summary once compaction has run) are reserved and can
  never be evicted.
- Long sessions **auto-compact** older turns into a summary once they pass
  `tiermux.agent.autoCompactThreshold` (default 80 % of the window).
- Bulky tool output is **compacted in two tiers**: tier 1 shrinks command output to
  head + tail; tier 2 (only if still over budget) reaches further, keeping file reads and
  edits — the evidence later steps reason over — intact as long as possible.
- Ambient open-editor context is sliced to a character budget.
- Sub-agents return **only their report**, so the main conversation stays small.

---

## “Why this model?”

Every assistant message footer carries a **routing icon**. Click it and a popover explains
the selection for that turn — the winner *and* why every other candidate lost.

```
Why groq::openai/gpt-oss-120b?
 ✓ groq::openai/gpt-oss-120b
   Score 1.00 · Capability 1.00 · Runtime ×1.00 · Confidence 0%
   task table (coding) — serves this turn
 · cerebras::gpt-oss-120b
   Score 1.00 · Capability 1.00 · Runtime ×1.00 · Confidence 0%
   task table (coding) — failover #1
 · google::gemini-2.5-flash
   Score 0.80 · Capability 0.80 · Runtime ×1.00 · Confidence 0%
   enabled tail · intelligence rank 2 — failover #2
 · openrouter::…
   Score 0.00 …
   no API key stored for this platform
```

**The four numbers**

| Field | Meaning |
|---|---|
| **Score** | Final ranking = Capability × Runtime × your preference. Highest wins. |
| **Capability** | Catalog fit — intelligence rank, speed, tool/vision support, context window. Static: it does not move with latency or health. On the picker path it is `(6 − intelligenceRank) / 5`. |
| **Runtime** | Live health multiplier learned from real requests — success rate, latency vs the model's *own* baseline, rate-limit/key availability, provider health. ~1.0 healthy, lower = degraded now. |
| **Confidence** | How much real data backs Runtime. Low % = little history, so Runtime leans toward a neutral default instead of over-reacting. |

Hovering any number shows that same explanation inline.

> **Reading the numbers honestly:** **Runtime is always a neutral 1.0 and Confidence always 0.**
> Nothing keeps a learned health multiplier any more — the scoring Router that produced real
> values for them was retired (see §B) — so ordering comes from the task table and intelligence
> rank, and the `reason` line is the only real signal. The two columns are kept in the payload
> (`src/router/picker.ts`) so the card's layout and the message contract stay stable.

**The reason line** is where the actual answer lives:

| Reason | What happened |
|---|---|
| `pinned by you — serves this turn` | you chose it in the model dropdown |
| `task table (coding) — serves this turn` | the curated first choice for this task kind |
| `enabled tail · intelligence rank 2 — failover #2` | reached by rank after the table |
| `not enabled in Manage Models & Keys` | its checkbox is off |
| `provider switched off in Manage Models & Keys` | the provider switch is off |
| `no API key stored for this platform` | keyed provider, no key |
| `in failure cooldown (recent errors)` | it failed recently and is backing off |
| `catalog says this model cannot call tools` | this turn offers tools; it can't call them |
| `tool-incompatible platform` | it advertised tools then rejected the payload — quarantined |
| `excluded for this retry` | already tried and failed on this turn |

So “it stopped using my model” always has a printed answer, one click away.

---

## Algorithms & techniques

All implemented natively — there is no external routing service in the path.

| Technique | Where it runs | Role |
|---|---|---|
| Regex-first task classification, bilingual (English + romanized Bengali) | every turn | picks the task kind without a model call; routing is language-invariant |
| Task table → intelligence-rank tail | picker | curated first choice per kind, then the whole enabled pool best-first — never a dead end |
| Availability + quality failover | picker | an empty-but-HTTP-200 answer fails over exactly like a 429 |
| Exponential per-model cooldown (30 s → 2 min) | picker | stops hammering a model that just failed; resets on success |
| Round-robin platform diversity in the failover scan | picker | one provider's twenty models can't consume every retry |
| Per-key rotation with per-key cooldown | secret store | a dead/limited key rotates inside the provider before the platform is written off |
| Equal-rank head rotation | picker | among models tied on intelligence rank, successive turns start at a different one, so quota spreads without the rationale naming a model that never ran |
| Time-boxed tool-incompatible / deprecated quarantine | secret store | models that advertise tools then reject them (or 404) self-heal after the window |
| Conservative rate-limit floors for unknown quotas | rate tracker | a catalog limit of `0` means “unknown”, not “unlimited” — guessing low is the safe direction |
| Per-model context fitting with reserved anchors | budget | the task and the conversation anchor can never be evicted by a fat tool result |
| Two-tier tool-output compaction (head + tail) | compact | command output shrinks first; file reads/edits stay verbatim as long as possible |
| Rolling-summary auto-condense | condense | older turns become a summary that carries the touched-file list forward |
| Local-server context-window probing | providers | asks LM Studio / Ollama / llama.cpp / KoboldCpp / vLLM what window is *actually* loaded |
| Streaming `<think>` stripping | router | reasoning tags that span chunks are folded, not dumped into the answer |
| Task-pattern sub-agents (`delegateTask`) | tools | isolated research workers; only their report reaches the main context (~85–95 % fewer tokens on research passes) |
| Explicit plan boundary as a tool call (`exitPlanMode`) | plan mode | the model *declares* the plan; the host never classifies prose to guess whether a reply “was a plan” |
| Cassette record/replay + scripted mock fixtures | tests | real agent loops exercised with zero API tokens |

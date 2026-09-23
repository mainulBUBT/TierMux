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
   - the **task table** entries for that kind (curated best-first per kind) — rotated turn by
     turn among themselves (see "Equal-rank head rotation" below: the same rotation the tail
     uses also covers the table now, not just what comes after it), with a declared-quota
     nudge that lets a fresher sibling jump ahead of one running low;
   - **every other enabled, usable model**, sorted by the catalog's measured
     **intelligence rank** (best first) and remaining declared quota, unranked models keeping
     your settings order.

   **Agent turns (`work`) are smartest first**: no task table and no speed gate — the whole
   enabled pool is ordered by quality tier (`frontier` → `strong` → `mid` → …), then
   intelligence rank, then your 👍/👎, with speed only breaking ties. A fast mid-tier model
   never leads over a frontier one; a slower model that finishes in fewer tool calls is the
   faster turn.

   For the other kinds the table **head is gated** (static catalog data — tiers and speed
   ranks, no learned signal): on tool turns, `small`/`unknown`-tier models never lead;
   `longContext` leads with `mid` and up, and never with a `speedRank ≥ 4` row. Skipped rows
   stay in the tail as failover, so the chain never empties.
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

All three failover time bounds are settings since 2026-09-22, defaulting to the historical
values: `tiermux.agent.connectTimeoutMs` (60 000, per-candidate time to headers),
`tiermux.agent.firstContentTimeoutMs` (30 000, time to the first real content chunk once a
stream started) and `tiermux.agent.chainDeadlineMs` (120 000, stop starting candidates).
Custom/local endpoints are exempt from all three. With `tiermux.agent.diagTrace` on, the
diag channel also logs per-candidate first-chunk times (`rp.ttft`), per-candidate settle
times (`rp.candidate`) and per-step wall-clock (`engine.step`) — read-only observability;
selection stays un-learned by design.

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
- Inside an agent turn, **Cline compacts** older conversation before a request would overflow
  the routed model's window (deterministic, no extra model call), and recovers once from a
  provider that still rejects a request as too long. The router reports each serving model's
  window so compaction sizes to the model that actually answers.
- Ambient open-editor context is sliced to a character budget.

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
| `mid tier, speedRank N — below the agent head floor; tail failover only` | below the task kind's minimum tier AND not fast enough to buy its way in — tail, never head |
| `speedRank N — too slow to lead a coding turn; tail last resort` | slow row on an interactive kind; sorted last in the tail |
| `tool-incompatible platform` | it advertised tools then rejected the payload — quarantined |
| `excluded for this retry` | already tried and failed on this turn |

So “it stopped using my model” always has a printed answer, one click away.

---

## Algorithms & techniques

All implemented natively — there is no external routing service in the path.

| Technique | Where it runs | Role |
|---|---|---|
| Regex-first task classification, bilingual (English + romanized Bengali) | every turn | picks the task kind without a model call; routing is language-invariant |
| Task table → intelligence-rank tail | picker | agent turns: the whole enabled pool by tier then rank; other kinds: a curated first choice, then the pool best-first — never a dead end |
| Availability + quality failover | picker | an empty-but-HTTP-200 answer fails over exactly like a 429 |
| Exponential per-model cooldown (30 s → 2 min) | picker | stops hammering a model that just failed; resets on success |
| Round-robin platform diversity in the failover scan | picker | one provider's twenty models can't consume every retry |
| Per-key rotation with per-key cooldown | secret store | a dead/limited key rotates inside the provider before the platform is written off |
| Equal-rank head rotation | picker | among models tied on intelligence rank — task table entries for the kind included — successive turns start at a different one, so quota spreads without the rationale naming a model that never ran |
| Declared-quota headroom nudge | picker / rate tracker | a candidate under ~25% of its declared rpm/rpd yields to a sibling with meaningfully more room, before `canSend`'s hard cliff would force a failover — deterministic, off the catalog's declared limits, not a learned/live signal |
| Time-boxed tool-incompatible / deprecated quarantine | secret store | models that advertise tools then reject them (or 404) self-heal after the window |
| Conservative rate-limit floors for unknown quotas | rate tracker | a catalog limit of `0` means “unknown”, not “unlimited” — guessing low is the safe direction |
| Per-model context fitting with reserved anchors | budget | the task and the conversation anchor can never be evicted by a fat tool result |
| Window-sized request compaction | Cline | older conversation is compacted to the serving model's window before a request overflows, with one recovery if a provider still rejects it |
| Local-server context-window probing | providers | asks LM Studio / Ollama / llama.cpp / KoboldCpp / vLLM what window is *actually* loaded |
| Streaming `<think>` stripping | router | reasoning tags that span chunks are folded, not dumped into the answer |
| Cassette record/replay + scripted mock fixtures | tests | real agent loops exercised with zero API tokens |

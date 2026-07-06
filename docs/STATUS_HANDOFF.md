# TierMux — Status & Handoff

**Last updated:** 2026-07-05
**Purpose:** অন্য agent যেন কাজ ধরে চালাতে পারে — কী হয়েছে, কী বাকি, কোথায় কী।

---

## ১. Project এক নজরে

TierMux একটা VS Code extension — multi-provider LLM router + agent (OpenCode-backed)। দুটো main surface:

| Surface | জায়গা | approach |
|---------|-------|----------|
| **Extension host** (Node) | `src/*.ts` | TypeScript, esbuild bundle |
| **Webview UI** (browser) | `media/src/*.ts` → `media/main.js` | **vanilla TS, imperative DOM** (Preact নয়) |

Build: `npm run build` (esbuild, production) → green ✅

---

## ২. যা করা হয়েছে (recent work)

### Phase D2: webview handler extraction ✅ COMPLETE

`media/src/main.ts` একটা ৩৪০০-লাইনের monolith ছিল। সেখান থেকে **৪টি core lifecycle handler** আলাদা file-এ বের করা হয়েছে:

```
media/src/handlers/
├── todos.ts          (৯১ লাইন)  — PR5.0
├── assistantStart.ts (৯৬ লাইন)  — PR5.1
├── agentStep.ts      (৮৪ লাইন)  — PR5.2
└── toolStatus.ts     (৫৩ লাইন)  — PR6
```

**Pattern প্রতিটায় same:**
- focused `XContext` interface (capability-based, ২-৪টা member)
- `handleX(ctx, msg)` একটাই exported function
- main.ts-এ import + switch case থেকে call + পুরোনো inline impl delete
- structural typing — `HandlerContext` export করা হয়নি (God Object propagate না করতে)

### Commit history (clean, bisect-friendly)
```
ad145cc  docs: ensureTarget future-abstraction note (Phase D2 closeout)
d5bbc2f  PR6   toolStatus extract
8b23a37  PR5.2 agentStep extract
d42cc24  feat: telemetry profiler system  ← আলাদা feature, Phase D2 নয়
42cbf38  PR5.1 assistantStart extract
ad4904c  PR5.0 todos extract
60849a5  PR4 typed handler boundaries
```

### Capability overlap (৪ context compare করে)
```
                 todos  asstStart  agentStep  toolStatus | uses
ensureTarget       ✅       ✅        ✅         ✅     |  4  ← abstraction candidate (note রাখা)
setStatusLabel      —        ✅        ✅         ✅     |  3
startStatusTimer    —        ✅        ✅         —     |  2
activityFor         —        —         —          ✅     |  1
upsertTool          —        —         —          ✅     |  1
scrollDown          —        —         ✅         —     |  1
renderTodos         ✅       —         —          —     |  1
```

main.ts-এ line ~2532-এ note আছে: `ensureTarget` প্রথম shared abstraction candidate হিসেবে চিহ্নিত। **এখন extract করা হয়নি** (premature abstraction এড়াতে)।

### অন্য কাজ (Phase D2 নয়)
- **Telemetry profiler system** — `src/profiler/` (live + no-op), commit `d42cc24`। Fully separate feature।

---

## ৩. যা বাকি (কাজের পুল)

### ⏸️ Verification (এখনই করতে হবে)
- [ ] **toolStatus smoke test** (manual) — Phase D2 officially close করতে।
  - Extension reload → tool চলে এমন prompt → tool card দেখুন, running→done transition, timer, auto-scroll, console error নেই।

### 🐛 Follow-up: Ask mode research budget and citation compliance (2026-07-06)
Context: `sdk.ts`'s `runChatStream` had a direct-router bypass (skips OC entirely)
that had been widened from `taskKind === 'trivial'` to `'chat'||'trivial'` —
since `classifyTask` maps nearly every real question to `'chat'`, this silently
defeated `ocConfig.ts`'s `GROUNDED` preamble for all broad Ask-mode questions.
Reverted in `cdff185` (`fix(oc): restore chat-mode OC routing for real
questions, not just trivial greetings`).

Live `tiermux.verifyGrounding` run after the revert confirms broad questions now
correctly reach OC (real grep/glob/readFile calls, grounded answer citing real
project files) — but exposed a **separate, pre-existing** problem:
- ❌ 38 tool calls for one broad question (budget target: 8)
- ❌ Required `[path:line]` citations missing despite the prompt mandating them
- A couple of `invalid` tool-call entries in the trace (worth root-causing)

`f9debaf`'s RESEARCH BUDGET prose instructions aren't holding under real
free-tier model behavior (observed on `Mistral codestral-2501`). Prose alone
("use at most 8 tools") isn't a guarantee — different models follow
instructions with very different reliability.

**Update 2026-07-06 — deterministic mid-turn enforcement investigated and
closed as not viable.** A full investigation (spike → design → live-tested
implementation, see the closed plan for detail) confirmed a mechanism using
OC's session-permission API (`PATCH /session/:id`) to gate research tools once
a per-turn counter crosses budget. Root cause, confirmed in OC's own source
(`session/prompt.ts:1085`): OC fetches the session record **once** before a
turn's multi-step tool-calling loop begins and reuses that same in-memory
object for every step — a mid-turn `PATCH` updates the database but the
already-running turn never re-reads it, so it can only affect the *next*
turn, never the one that tripped the budget. Not fixable by sending the PATCH
faster; the target turn structurally cannot observe the change. Live evidence:
tool `#9` correctly triggered `PATCH → ask`, PATCH returned success, and tools
`#10`-`#21+` still executed as plain `allow` with zero `permission.asked`
events for the rest of that turn.

Also learned along the way: `deny` removes a tool from the model's schema
entirely, silently repaired to an `invalid`-tool result by the AI SDK — this
**never** reaches OC's real `ctx.ask()`/`RejectedError`/`shouldBreak` path, so
the loop never actually halts (33-210 tool calls observed — worse than no
budget). `ask` + auto-reject does reach the real halt path (confirmed:
exactly 1 tool call, genuine stop) but can leave the turn with a completely
empty answer (confirmed via raw message history, not a UI/collector artifact).

`ocClient.updatePermission()` (commit `739cbd5`) is real, working, live-
verified API — kept in the codebase for any future *pre-turn* permission need,
just not sufficient alone for mid-turn enforcement.

**Next, if this is still wanted** (explicit decision needed, not a given): a
fresh, separate experiment using `client.abort(ocId)` to hard-stop the turn
outright once budget is hit, rather than a permission mutation. Not attempted;
would need its own verification (does abort preserve partial text, does the
session stay usable afterward). Treat as a new investigation, not a
continuation of the PATCH-based one.

**Do NOT reintroduce the chat-mode bypass to "fix" the call count** — that
regresses grounding to zero for every broad question, which is strictly worse
than "grounded but over-budget."

### 🔄 বড় কাজ (ভবিষ্যতের phase)

#### A. Preact rendering migration — **শুরু নয়**
- `package.json`-এ preact নেই, কোনো `.tsx` নেই।
- webview এখনও pure `document.createElement` imperative DOM।
- এটা **architecture-level rewrite**, mechanical extraction নয়।
- করলে পুরো `media/src/main.ts` rendering layer বদলাবে — handler files (`media/src/handlers/*`) থাকতে পারে বা ভেঙে যেতে পারে।

#### B. main.ts-এর বাকি handlers (৩১টা switch case)
এখনও inline। তিনটা category — **সবগুলো same pattern নয়**:

| Category | Handlers | Extract value |
|----------|----------|---------------|
| **Simple state-update** | config, customEndpointModels, sessionList, setInput, sessionTitle, usageTotals, notice, error, busy, clear, attachmentAdded, mentionResults, mcpRegistryResults, toggleSettings, toggleHistory, checkpoint, changedFiles | কম — প্রতিটা ~৫ লাইন। Extract করলে file বাড়বে, value না |
| **Interactive cards** | commandApproval, editApproval, planProposed, planDiscarded, askUserPrompt, askUserDismissed, clarifyingQuestions | মাঝারি — প্রতিটার নিজস্ব concern |
| **Streaming/session (ভারী)** | assistantChunk, assistantMessage, switchSession, failoverNotice, keyRotated | জটিল — main.ts-এর আসল ওজন এখানে |

> Phase D2 closeout-এর সিদ্ধান্ত: **বাকিগুলো force-extract করা হবে না।** যখন কোনো feature এর প্রয়োজনে streaming/session handler ধরতে হবে, তখন সেই feature-এর scope-এ extract হবে।

#### C. ensureTarget abstraction
- ৪/৪ handler use করে → candidate।
- **কিন্তু এখন করা হবে না** — যতক্ষণ না second concrete responsibility আসে।
- main.ts-এ note রাখা আছে।

---

## ৪. Key files ও pointer

```
media/src/
├── main.ts                 ← ৩৪০০ লাইন, এখনও monolith (routing + state + বাকি handlers + rendering)
├── handlers/               ← Phase D2 extracted (৪টা)
├── toolRendering.ts        ← Phase D PR3 (buildToolCard, toolLabel, activityFor)
├── markdown.ts             ← Phase D PR2
├── icons.ts, format.ts     ← stateless helpers
├── dom.ts, bridge.ts       ← $ , send, escapeHtml, RxMessage type

src/
├── extension.ts            ← entry
├── chatViewProvider.ts     ← webview host bridge
├── router/router.ts        ← multi-provider routing
├── agent/sdk.ts            ← OpenCode agent SDK
├── profiler/               ← telemetry (separate feature)
└── context/                ← userMemory, mentions, projectRules, telemetry context
```

### Type system note
- `media/src/main.ts`-এ উপরে `@ts-nocheck` (line 7) — Phase D baseline।
- নতুন module (`handlers/`, `toolRendering.ts` ইত্যাদি) strict-checked।
- `@ts-nocheck` সরানো একটা বড় কাজ (ভবিষ্যতে)।

---

## ৫. Decision log (যেগুলো পেছনে ফিরে না দেখার)

1. **HandlerContext export করা হয়নি** — God Object propagate এড়াতে। প্রতিটা handler নিজস্ব focused context define করে, structural typing-এ compatible।
2. **Premature abstraction নিষেধ** — `ensureTarget` ৪-এ ব্যবহৃত হলেও এখন extract করা হয়নি। Rule: অন্তত ৩ use + concrete responsibility না হলে abstract করবেন না।
3. **এক PR = এক capability extraction** — commit ছোট, reviewable, revert-friendly রাখা।
4. **Simple state-update handler extract করা হবে না** — diminishing returns। Force-extract = process-driven refactoring, code quality নয়।
5. **Streaming/session handlers (assistantChunk ইত্যাদি)** mechanical extraction নয় — architecture change। Feature-driven করতে হবে।

---

## ৬. কোথা থেকে শুরু করবেন (পরবর্তী agent-এর জন্য)

**সবচেয়ে কম ঝুঁকির কাজ:**
1. আগে toolStatus smoke test verify করুন।
2. তারপর decide:
   - Preact migration লাগবে? → আলাদা architecture phase, বড় পরিকল্পনা দরকার।
   - কোনো specific agent feature বাকি? → সেটার scope-এ কাজ।
   - নিছক maintenance/bug? → normal flow।

**যা করবেন না:**
- main.ts-এর বাকি handlers force-extract করবেন না (decision #4)।
- `ensureTarget` এখন abstract করবেন না (decision #2)।
- `@ts-nocheck` না ভেবে সরাবেন না।
- নতুন doc/framework file বানাবেন না যদি না সত্যিই দরকার হয় — process ইতিমধ্যে ভারী।

---

## ৭. Quick command reference

```bash
npm run build              # esbuild production bundle (webview + extension)
grep -n "function handleX" media/src/main.ts   # কোনো inline handler আছে কিনা
ls media/src/handlers/     # extracted handler files
git log --oneline -10      # clean Phase D2 history
```

---

**Bottom line:** Phase D2 (handler extraction) complete। Preact শুরু নয়। Full extension "done" define করা যায়নি — feature roadmap দরকার। পরবর্তী কাজ feature-driven হওয়া উচিত, process-driven নয়।

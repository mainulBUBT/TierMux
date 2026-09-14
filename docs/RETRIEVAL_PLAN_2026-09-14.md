# Host-side retrieval: give the model the right files before its first call

Status: PLAN, not implemented. Written 2026-09-14 for whoever builds it (human or agent).
Read [SIMPLE_CORE_RESET_2026-08-24.md](SIMPLE_CORE_RESET_2026-08-24.md) first: the engine
(`src/agent/core/engine.ts`) is not touched by this plan, and nothing here adds a model call.

## 1. Why

Free-tier models do not know where to look. Measured on a real session (HexaRide-Admin,
question "ei ai setup project er kon kon kaje use hocche janao", model
`Kilo/nex-agi/nex-n2.5-pro:free`, transcript `smu116lavsn15`-era, 2026-09-14):

| tool | calls | note |
|---|---|---|
| readFile | 101 | 45 distinct files, 132 re-reads (fixed the same day: budget-aware aging in `compact.ts`) |
| grep | 76 | 25+ overlapping regexes for the same 6 identifiers |
| glob | 20 | |
| total | 198 steps, 28 min, 891k prompt tokens | the final answer was correct |

The answer needed 4 greps and 5 file reads. A second turn on the same question with
`ChatAnywhere/gpt-4.1` took 40 calls and 3m40s and still hedged. Every call on a free gateway
is 5–15 s, so the number of calls is the whole latency story.

Retrieval removes the *search* phase: the host runs the greps the model would run, ranks the
files, and hands the model `path:line` hits plus an outline in its first request. Aider's repo
map, Cody's keyword mode, Tabby and SWE-Fixer all do a form of this; none needs a model call.

Target, measured on the same question and model after the aging fix: **≤ 12 steps**, grep+glob
≤ 5.

## 2. Non-goals

- No embeddings, no index on disk, no background service in this phase (phase 2, §9).
- No change to `engine.ts`, tool schemas, or the AI SDK loop.
- No LLM classification of the question. Term extraction is regex.
- Not a replacement for `@mention`. Mentioned files still win; retrieval fills in around them.

## 3. Where it plugs in

`src/chatViewProvider.ts`, `handleSendMessage` path, right after the active-editor block is
appended to `ctx` (today ~line 2083–2096, the `if (ctxCfg.get('includeOpenEditors'...)` block):

```ts
const retrieval = await retrieveContext(prompt, { alreadyIncluded: [...mentioned paths, activeRel] })
  .catch(() => undefined);
if (retrieval?.block) ctx = ctx ? `${ctx}\n\n${retrieval.block}` : retrieval.block;
diagLog('send.retrieval', `requestId=${m.requestId} · ${retrieval?.files.length ?? 0} files · ${retrieval?.ms ?? 0}ms · ${retrieval?.block.length ?? 0} chars`);
```

The block goes into the **user message** (`buildUserContent`), never the system prompt: the
system prompt is the stable cache prefix and is pinned under 10 000 chars by foundation
scenario 17.

Skip retrieval when: `classifyTask(prompt) === 'trivial'`; the setting is off; no workspace
folder; the prompt is a bare "continue"/resume (`isAmbiguousFollowup` already exists — reuse
it; a follow-up inherits the previous turn's context through the transcript).

## 4. New module: `src/context/retrieval.ts`

```ts
export interface RetrievedFile {
  path: string;                 // workspace-relative
  score: number;
  hits: Array<{ line: number; text: string }>;   // ≤ 4, deduped, trimmed to 160 chars
  outline?: string[];           // "kind name (line)" from symbolExtract, ≤ 12 entries
  via: 'term' | 'graph';        // matched a query term, or pulled in by graph expansion
}
export interface Retrieval { block: string; files: RetrievedFile[]; terms: string[]; ms: number }
export interface RetrieveOptions {
  alreadyIncluded?: string[];   // paths to exclude (mentioned / active editor)
  maxFiles?: number;            // default 8
  maxChars?: number;            // default 6_000
  timeoutMs?: number;           // default 800
}
export function extractQueryTerms(text: string): string[];
export async function retrieveContext(text: string, opts?: RetrieveOptions): Promise<Retrieval | undefined>;
```

### 4.1 Term extraction (`extractQueryTerms`)

Pure function, ASCII only (Bengali/Banglish words are dropped; the identifiers in such prompts
are still Latin). Ordered by specificity, deduped, max 12 terms:

1. Quoted strings: `"..."`, `'...'`, `` `...` `` (≥ 3 chars).
2. Path-like tokens: contain `/` or end in a code extension (`.php`, `.ts`, `.blade.php`, …).
3. Identifiers: CamelCase (`getIncompleteRide`, `AiSetupController`), snake_case
   (`payment_status`), SCREAMING_CASE, `Foo::bar`, `$var` (strip `$`), dotted (`admin.ai.blog`).
4. Codes: `[A-Z]{2,5}-\d{3,}` (`CBP-100014`), long digit runs ≥ 5 (`100109`).
5. Remaining plain words ≥ 4 chars, minus a stopword list (English function words plus the
   chat vocabulary: `check`, `please`, `file`, `code`, `project`, `system`, `issue`, `fix`,
   `add`, `make`, `show`, `also`, `still`, `ekta`, `kore`, `koro`, `hocche`, `janao`, …).
   Plain words are searched **whole-word, case-insensitive**; identifiers **case-sensitive**.

Never search a term under 3 chars, and never `id`, `data`, `user`, `name`, `status` alone
(they hit every file). Keep the term list in the block so the model sees what was searched.

### 4.2 Search

One ripgrep process per term, in parallel, all under the shared timeout. Reuse the spawn
pattern from `src/context/textSearch.ts` (`rgPath` from `@vscode/ripgrep`) but with these args:

```
--line-number --no-heading --color never --max-count 20 --max-columns 200
--glob '!**/node_modules/**' --glob '!**/vendor/**' --glob '!**/storage/**'
--glob '!**/dist/**' --glob '!**/build/**' --glob '!**/.git/**' --glob '!**/*.min.*'
--glob '!**/*.lock' --glob '!**/*.map' --glob '!**/public/**' --glob '!**/.tiermux-worktrees/**'
[-i for plain words] [-w for plain words] -e <term> .
```

`.gitignore` is honoured by ripgrep by default; keep that. Per-term cap 20 lines keeps a hot
word from flooding. Root = `effectiveRootUri().fsPath` (same as the tools).

### 4.3 Ranking (BM25-lite, no index)

For each file `f` and term `t`: `hits(f,t)` = matching lines (≤ 20).
`df(t)` = number of files with ≥ 1 hit. `N` = files hit by any term.

```
idf(t)     = log(1 + N / df(t))                     // rare terms weigh more
tf(f,t)    = 1 + log(hits(f,t))                      // diminishing returns per file
score(f)   = Σ_t idf(t) · tf(f,t) · w(t)             // w: quoted/path/code 2.0, identifier 1.5, word 1.0
bonus      = +25% if ≥ 2 distinct terms hit f        // co-occurrence beats a single hot term
penalty    = ×0.5 if path matches /(test|spec|fixture|migration|seed|lang\/|locale)/i
           = ×0.6 if the file is > 4 000 lines (generated/vendored)
```

Take the top `maxFiles` by score. Ties: shorter path first.

### 4.4 Graph expansion (one hop, symbol-based)

For the top 3 term-matched files:

- Run `extract(relPath, text)` from `src/context/symbolExtract.ts` (`ExtractResult` has
  `imports`, `exports`, `symbols[{name, kind, line}]`).
- **Callees**: resolve `imports` to workspace files when the import is relative or maps to a
  known root (`Modules/...`, `App\\...` → `app/...` via composer PSR-4 in `composer.json` if
  present; `@/` and `src/` for JS/TS). Skip packages.
- **Callers**: for the file's top 3 exported symbol names (class/function, ≥ 6 chars, not a
  common word), one extra ripgrep `-w <Name>` across the workspace, `--max-count 5`,
  `-l` (files only). Add those files.

Expansion files get `via: 'graph'` and score = 0.5 × the source file's score. They must not
push a term-matched file out of the top `maxFiles`; cap expansion at 3 files total.

### 4.5 Block format

Only what the model needs to jump: path, matching lines, outline. Never file bodies.

```
<retrieved_context terms="getIncompleteRide, unpaid, CBP-100014, book">
Search hits for the request, ranked. Start here; open a listed file only for the lines you need; search again only for what this does not cover.

## Modules/TripManagement/Repository/Eloquent/TripRequestRepository.php  (hits: 3)
  142: public function getIncompleteRide(string $customerId, ?string $type = null)
  151:     ->where('payment_status', 'unpaid')
  outline: class TripRequestRepository (12) · getIncompleteRide (142) · getUnpaidTrip (167) · …

## Modules/CarpoolManagement/Http/Controllers/Api/Customer/BookingController.php  (hits: 1, calls getIncompleteRide)
  88:     $unpaid = $this->tripRequestService->getIncompleteRide($customer->id);
  outline: class BookingController (18) · store (61) · cancel (140)

## … (≤ 8 files)
</retrieved_context>
```

Rules: `maxChars` cap (default 6 000 ≈ 1.8k tokens) enforced after formatting — drop whole
files from the bottom, never truncate mid-file. Hit lines trimmed to 160 chars, leading
whitespace collapsed. The `terms=` attribute lists what was searched so the model knows what
was NOT searched.

### 4.6 Timeout and failure

`timeoutMs` (800 ms default) covers the whole call. On timeout, return what is ranked so far;
on any error return `undefined`. Retrieval must never delay or fail a turn: the caller wraps it
in `.catch(() => undefined)`.

## 5. Prompt: one line

`src/context/system.ts`, section `# What you already have` — add `<retrieved_context>` to the
list in the existing sentence and append:

```
'<retrieved_context> holds grep hits (path:line) for the terms in the request: start there, open a listed file only for the lines you need, and search again only for what it does not cover.'
```

Check the pin: foundation scenario 17 (`prompt length pinned < 10_000`). The agent prompt is
within ~40 chars of it today; trim elsewhere in the same section if needed.

## 6. Settings (`package.json` → `contributes.configuration`)

| key | type | default | description |
|---|---|---|---|
| `tiermux.context.retrieval` | boolean | true | Before each turn, grep the workspace for the identifiers in your message and give the model the matching files and lines. No model call; ~0.3–0.8 s. |
| `tiermux.context.retrievalMaxChars` | number | 6000 | Size cap of the retrieved block. |

Read them next to `includeOpenEditors` in `chatViewProvider.ts`.

## 7. Tests

### 7.1 `scripts/retrieval.e2e.ts` (+ `test:e2e:retrieval` script in `package.json`, same esbuild
pattern as `test:e2e:grep-options`, run with `-r ./scripts/vscodeMock.cjs`, external `@vscode/ripgrep`)

Build a temp workspace with `makeWorkspace()`-style helpers (see `foundation.e2e.ts`) and use
`runWithWorkspaceRoot`. Files:

```
app/Repository/TripRequestRepository.php   // class with getIncompleteRide, getUnpaidTrip; 'payment_status' => 'unpaid'
app/Http/Controllers/BookingController.php // use App\Repository\TripRequestRepository; calls ->getIncompleteRide(
app/Http/Controllers/OtherController.php   // unrelated
vendor/foo/Bar.php                         // contains getIncompleteRide — must NOT appear
tests/Feature/BookingTest.php              // contains getIncompleteRide — must rank below app/
resources/lang/en/lang.php                 // 'unpaid' => 'Unpaid' — must rank low
```

Assertions (each an `ok(...)` line, this repo's style):

1. `extractQueryTerms('Rider skip to pay, still books. check getIncompleteRide and CBP-100014')`
   → contains `getIncompleteRide`, `CBP-100014`, `books`/`pay`? (plain words) and NOT `check`, `and`, `to`.
2. Repository file ranks first; `via: 'term'`, hits include the `getIncompleteRide` line number.
3. BookingController appears (graph: callers of `getIncompleteRide`) with `via: 'graph'` even
   if the prompt never names it; its hit line is the call site.
4. `vendor/` file absent; `tests/` file ranked after both app files.
5. Block starts with `<retrieved_context terms=` and ends with `</retrieved_context>`; every
   `## ` path exists in the workspace; no file body (no line of the source longer than 160 chars appears verbatim).
6. `maxChars: 400` → block ≤ 400 chars and still well-formed (whole files dropped).
7. A prompt with no searchable term (`'thanks, that is all'`) → `undefined`.
8. A prompt of only Bengali script → `undefined` (no ASCII terms).
9. `alreadyIncluded: ['app/Repository/TripRequestRepository.php']` → that file absent, the
   controller still present.
10. `timeoutMs: 1` → resolves (no throw) within ~100 ms, result `undefined` or partial.

### 7.2 `scripts/foundation.e2e.ts` — one scenario

Through the real pipeline (mock model, temp workspace, `mode: 'ask'`): the first model call's
user message contains `<retrieved_context` naming the file that holds the identifier from the
prompt; a `'hello'` turn contains no `<retrieved_context`. Keep it to two `ok(...)` lines.

### 7.3 Contract suites that must still pass

`npm run test:e2e:foundation` (the contract), `test:e2e:grep-options`, `test:e2e:close-loop`,
`test:e2e:tool-offer`, `npm run typecheck`.

## 8. Measure, then decide phase 2

Same workspace (HexaRide-Admin), same question, same model, Auto off (pin the model):

| | before (2026-09-14) | after aging fix | after retrieval |
|---|---|---|---|
| steps | 198 | ? | target ≤ 12 |
| grep+glob | 96 | ? | target ≤ 5 |
| wall clock | 28 min | ? | target ≤ 2 min |

Read the numbers from the session JSON under
`~/Library/Application Support/Code/User/workspaceStorage/<hash>/mainul-islam.tiermux/sessions/`
(`transcript[].steps[].name`) — no diag log needed. If grep+glob is already ≤ 5 after the
aging fix alone, stop here and do not build phase 2.

## 9. Phase 2 (separate PR): local semantic layer

Only if §8 shows natural-language questions ("rider skips payment") still miss code with no
shared vocabulary (`payment_status`).

- `@huggingface/transformers` (transformers.js, ONNX), model `Xenova/bge-small-en-v1.5`
  quantized (~33 MB, 384-d). Decision recorded: no Gemini/hosted embeddings — no key, no
  quota. Model downloaded on first use to `globalStorageUri/models/`, or bundled if size allows.
- Chunk with `symbolExtract` boundaries (function/class), fall back to 60-line windows.
  Index = `{path, hash, chunks[{start,end,vec:Float32Array}]}` in `globalStorageUri/index/<workspace-hash>.bin`;
  re-embed only files whose hash changed; index in the background, never block a turn.
- Query: embed the prompt once (time-cap 500 ms; on miss, keyword-only), cosine top-20,
  fuse with the keyword ranking by Reciprocal Rank Fusion (`1/(60+rank)`), then the same
  graph expansion and block format. Nothing else in the pipeline changes.
- Setting `tiermux.context.semanticRetrieval` (boolean, default false until measured).
- Risks to check first: ONNX runtime loads inside the VS Code extension host (Continue.dev
  does this); package size; first-index CPU on a 10k-file repo (cap files by size and count).

## 10. Test procedure, step by step

Three layers, in this order. Do not skip to the live test: the unit suite is what tells you
*which* part is wrong when the live numbers disappoint.

### 10.1 Unit: the module alone (`scripts/retrieval.e2e.ts`)

1. Add the script to `package.json` next to `test:e2e:grep-options`, same shape:
   ```
   "test:e2e:retrieval": "esbuild scripts/retrieval.e2e.ts --bundle --platform=node --format=cjs --external:vscode --external:@vscode/ripgrep --outfile=dist/retrieval.e2e.cjs && node -r ./scripts/vscodeMock.cjs dist/retrieval.e2e.cjs"
   ```
2. Build the fixture workspace in a temp dir (`fs.mkdtempSync`), write the six files of §7.1,
   and run every call inside `runWithWorkspaceRoot(root, () => ...)` so `effectiveRootUri()`
   points at it (see how `foundation.e2e.ts` scenario 16 does this).
3. Assert the ten cases of §7.1 with the repo's `ok(name, cond, detail)` helper; end with
   `process.exit(bad === 0 ? 0 : 1)` so CI fails loudly.
4. Run: `npm run test:e2e:retrieval`. Expected output: `PASS` on every line, last line
   `ALL PASS`. On a `FAIL`, print `JSON.stringify(result, null, 1)` for that case — the block
   text and the `files[]` array make the ranking mistake obvious.
5. Ripgrep sanity if nothing matches at all: `node -e "console.log(require('@vscode/ripgrep').rgPath)"`
   must print an existing binary; run it by hand with the §4.2 args against the fixture.

What each case proves:

| case | proves |
|---|---|
| 1 | term extraction keeps identifiers/codes, drops chat words |
| 2 | ranking: the defining file is first |
| 3 | graph expansion finds the caller the prompt never named |
| 4 | ignore globs work (`vendor/`), test/lang files sink |
| 5 | block is well-formed and contains no file bodies |
| 6 | the char cap drops whole files, never cuts mid-file |
| 7, 8 | no searchable term → nothing injected (no noise on greetings/Bengali-only) |
| 9 | mentioned/active files are not duplicated |
| 10 | a timeout can never throw or hang the turn |

### 10.2 Pipeline: it reaches the model (`scripts/foundation.e2e.ts`)

1. Add scenario **31** after scenario 30, using `createMockModel([{ text: 'ok' }])`,
   `engineTurn(...)` with `mode: 'ask'`, inside a `makeWorkspace()` that contains one file
   with a distinctive identifier, e.g. `app/Foo.php` holding `function computeSurchargeTotal(`.
2. Prompt: `'where is computeSurchargeTotal used?'`. Assert on `JSON.stringify(m.calls[0].messages)`:
   - contains `<retrieved_context`;
   - contains `app/Foo.php`;
   - the system prompt (`m.calls[0].messages[0]` or the `system` option, whichever the harness
     exposes) does **not** contain `<retrieved_context` — the block must be in the user message.
3. Prompt `'hello'` → the messages do not contain `<retrieved_context`.
4. Run `npm run test:e2e:foundation`. Expected: `ALL 33 FOUNDATION SCENARIOS PASS` (the
   count in that line goes up by one — update the string in the script). Scenario 17 (prompt
   length pin) must still pass after the §5 prompt line.

### 10.3 Live: the number that matters

Setup once:

1. `node esbuild.js --production && npm run build:types && npm run package`, then
   `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension tiermux-3.0.1.vsix --force`.
   (`npm run build` currently fails in `sync:catalog` on a retired NVIDIA model id; that is
   unrelated — bundle directly as above.)
2. Verify the installed bundle is the one you built:
   `md5 -q dist/extension.js` must equal
   `md5 -q ~/.vscode/extensions/mainul-islam.tiermux-3.0.1/dist/extension.js`.
3. Reload every VS Code window (`Developer: Reload Window`). A window that is not reloaded
   runs the old code and will silently produce the old numbers.

Run the benchmark, three prompts, each in a **new chat**, Ask mode, the model **pinned**
(not Auto — otherwise the model changes between runs and the numbers are not comparable):

| # | prompt | expected |
|---|---|---|
| A | `ei ai setup project er kon kon kaje use hocche janao` (HexaRide-Admin) | ≤ 12 steps, grep+glob ≤ 5, answer names `AiSetupController`, `OpenAiService`, blog routes |
| B | `Rider skips paying for a trip but can still book. Where is the unpaid-trip check, and which booking endpoints call it? check getIncompleteRide` (HexaRide-Admin) | ≤ 12 steps; first readFile is the repository or a booking controller, not a glob |
| C | `hola` | 1 step, no tools, no `<retrieved_context` in the request |

Read the numbers from the session file, not from memory. Latest session of the workspace:

```bash
D=~/Library/Application\ Support/Code/User/workspaceStorage
f=$(ls -t "$D"/*/mainul-islam.tiermux/sessions/*.json | head -1)
node -e '
const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const a=[...s.transcript].reverse().find(m=>m.role==="assistant");
const t={};for(const st of a.steps||[])t[st.name]=(t[st.name]||0)+1;
console.log({model:a.model,secs:a.secs,steps:(a.steps||[]).length,tools:t,promptTokens:a.usage&&a.usage.promptTokens});
' "$f"
```

Also open the turn's "Why this pick" popover and the first tool card: the first `readFile`
should target a file that the retrieved block listed. If the model's first calls are still
`glob`/`listDir`, the block arrived but was ignored — that is a prompt problem (§5), not a
retrieval problem; check the block is present in the request by setting
`tiermux.agent.diagTrace: true` and reading the `send.retrieval` line in the
**TierMux Diag** output channel (`View → Output → TierMux Diag`).

Record before/after in the §8 table. Pass = A and B under the targets on the same pinned
model; C unchanged.

### 10.4 Edge checks, live, one prompt each

| check | prompt / setup | expect |
|---|---|---|
| Bengali-only | `এই প্রজেক্টে পেমেন্ট কোথায় হয়` | no block; the model still answers (Scope rule) |
| @mention overlap | `@app/Http/Controllers/BookingController.php how does booking work` | block present but that path absent from it |
| big repo timing | Backend-6amMart or any repo with > 5 000 files | `send.retrieval` line shows ≤ 800 ms; the turn does not stall before "Thinking…" |
| setting off | `tiermux.context.retrieval: false` | no `send.retrieval` line, no block |
| active editor | open `AiSetupController.php`, ask "what does this do" | block present; that file not duplicated (it is in `<active_editor>`) |
| plan mode | same prompt B in Plan mode | block present; plan steps cite the retrieved `path:line`s |

### 10.5 Regression suites

Run and paste the last line of each into the PR:

```
npm run typecheck
npm run test:e2e:foundation
npm run test:e2e:retrieval
npm run test:e2e:grep-options
npm run test:e2e:close-loop
npm run test:e2e:tool-offer
npm run test:e2e:exit-plan-mode
```

## 11. Constraints for the implementer

- Comments: one or two lines, the *why* and a repro date; no narrative blocks (repo rule).
- Prompt text: principle + reason, not rule lists.
- No new model calls anywhere in this plan. No engine edits. Retrieval failures are silent.
- Do not commit; the maintainer commits after review. Run PUBLISHING.md checks before any push.
- Verify with the suites in §7.3 and report the §8 numbers with the PR.

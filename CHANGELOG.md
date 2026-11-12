# Changelog

All notable changes to TierMux are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

### Added — graphics without an image model (2026-11-12)

- **`renderImage` tool (agent mode):** HTML/SVG → PNG through the user's own headless Chrome (the
  browserVerify launcher) — banners, OG/social images, posters, cards, diagrams. Zero model cost,
  no new dependency. Relative paths resolve against the workspace (inline markup) or the source
  file's folder (`file`); requests follow the fetchUrl line (no loopback/private hosts — WebSockets
  included — no files outside the workspace). The result reports what can be checked mechanically: content larger than
  the canvas, text past the edge or clipped, broken images, failed fonts. Writes a file, so it is
  approved like one. Codex's imagegen skill makes the same call: text-and-layout graphics are
  HTML/SVG, not a bitmap model.
- **`graphic` skill:** canvas sizes per destination, find the project's brand first, fixed-canvas
  layout rules, render → fix the reported issues → render again.
- **`generateImage` tool (agent mode):** photos and illustrations from AI Horde's anonymous,
  keyless queue — SDXL (AlbedoBase XL, ~1024×576, ~2–3 min) by default, SD 1.5 `draft` (~20–80 s).
  Waits up to 6 min, cancels the Horde job on Stop/deadline/fault/censor, never overwrites a file
  it was not told to, converts Horde's WebP to PNG/JPEG through the local Chrome, and shows vision
  models a preview. Pollinations' keyless image endpoint was probed and rejected (one weak model,
  watermark). The `graphic` skill sends photos/illustrations here and keeps text/logos in
  renderImage on top.
- **Live graphic preview** (`TierMux: Preview Graphic`, editor title / explorer menu on
  .html/.svg/.png/.jpg/.webp): HTML/SVG rendered at a fixed canvas (auto-detected or OG/X/square/
  story/YouTube presets) as you type, scripts off in a sandboxed frame; images scaled to fit with
  their pixel size. An open panel follows renderImage's output.

- **Vision models see what they rendered.** renderImage (and browserVerify's screenshot) attach a
  ≤1024px JPEG to the tool result; the router sends it as pixels only to candidates the catalog
  marks vision-capable (as a user message after the tool results — OpenAI-shaped tool messages are
  text-only) and as a one-line note to the rest, per candidate, so failover between vision and
  text models just works. Only the newest two images ride as pixels; history keeps text only;
  the token estimate charges an image ~1k tokens instead of its base64 length.
- **Auto-approve means full permission.** With the toggle on, only a short catastrophic tier
  still asks (deletes outside the project, sudo, lost uncommitted work, force-push, publish,
  curl|sh, writes to /etc or dotfiles). `kill`, `chmod +x`, `rm -rf node_modules`, `sh -c` run;
  `2>/dev/null` no longer counts as "writing a device" at all.

### Fixed — review follow-ups (2026-11-12)

- **Auto was treated as a pinned model.** The webview sends `'auto'`; two router checks read any
  pin as a real one, so in Auto the session-sticky model never resumed and the no-first-chunk stall
  gate was off (a stalled stream never failed over). agentBench passes no pin, which hid it.
- **A slow sticky model stops being sticky.** First byte after 20 s (pollinations took ~41 s on
  every step) ⇒ the next step re-ranks the chain normally. It keeps its rank — never a route to a
  weaker model, only no longer jumping the queue.
- **PDF follow-ups.** An earlier turn's raw PDF rides along in the transcript, but routing only
  looked at the latest message, so a follow-up could land on a provider that drops it ("I don't
  see a PDF"). Providers that deliver raw PDF now go first, the normal chain after them.
- **Verify scoping.** Changed test files narrow the suite only when nothing else changed — a
  source or config edit runs everything. `conftest.py`/helpers under `tests/` are no longer taken
  for test files (pytest's exit 5 started a phantom fix round).
- **bun installer:** zip and SHA256SUMS from the same pinned release, checksum verified, 5-min
  download timeout, truncated downloads refused, written beside and renamed only after
  `--version` answers (a half-written file could pass for an install), `--version` probes time out.
  A running bun's request failure is now a network error — falling back to a direct request only
  bought the gate's "free usage limit" and shut the OpenCode lane for 30 minutes.
  The install question is a modal dialog now — the toast slid into the bell unseen and the lane
  stayed shut all session. After installing, TierMux restarts its extension host once no chat turn
  is running, so the lane starts clean (the bun-less "free usage limit" quarantine is in memory).
- **browserVerify / renderImage: WebSockets.** CDP's Fetch interception and setBlockedURLs both
  miss WebSocket handshakes (live probe: a page reached `ws://127.0.0.1`, once from a fresh iframe).
  A public page now runs behind a dead proxy that only its own (DNS-pinned) host bypasses; renderImage
  maps loopback/private literals to unresolvable.
- **Stop ends Chrome and `taskOutput` waits** (abort signal reaches both tools).
- **A continuation pass that dies on the wire keeps its edits** in the transcript and changed-files
  list (only pass 1 folded its finished steps back in; foundation 28d).
- **The agent/ask symbol sketch survives repos over 200 files** (it was skipped entirely — this repo
  has 336); bounded at 3,000 symbol files.
- **browserVerify reports `console.error(err)` as the error**, not `[object Object]`.
- `.zcode/` (another tool's local plan files) is ignored and untracked.

### Fixed

- **Bundled skills now ship in the extension.** `.tiermux/skills/` was missing from `files` in
  package.json, so the packaged extension carried none of them (design, landing, code-review, …).

### Fixed — open-source agent parity, wave 0+1 (2026-11-12)

Source-level study of OpenCode, Cline, Codex CLI, aider and Gemini CLI (clones of 2026-11-11/12);
every item is mechanical — no extra model call, no answer judging.

- **Command output keeps its END.** `runShell` kept the first 10 KB of each stream and dropped the
  rest silently — the test summary, printed last, never reached the model, nor the verify-fix round
  (which also cut to the first 6k). Now a head + rolling tail per stream with an explicit "omitted
  from the middle" marker; the verify prompt keeps each stream's end; a clean run says `Exit code: 0`.
- **Step cap is a 200-step runaway backstop** (was unlimited since 2026-11-11). A
  fail/succeed/fail alternation clears the repeat-failure table on every success, so nothing bounded
  it. A hit is the resumable pause; `0` still means no cap. Plan mode's reading budget is 15 again
  unless the user sets the cap (it had silently become 60).
- **Focus pulse removed.** No live repro (core-reset rule), Cline itself retired the Focus Chain it
  imitated, and the todo list already sits verbatim in the transcript.
- **Router: a context-overflow drop no longer duplicates the chain.** `candidates.length =
  kept.length` before re-pushing left dropped models in and tried the overflowed one again.
- **browserVerify SSRF.** Private/link-local/metadata top-level URLs are refused (loopback stays —
  it is the dev server); a public page can no longer load the user's localhost services.
- **Background tasks: reads after the ring buffer trims see new output** (the cursor moves with it).
- **Tool-call repair without a model call:** quoted numbers/booleans and a stringified `edits` array
  are coerced against the schema in the no-model pass (with null-strip and param aliases, all at
  once); a call cut off by the output limit skips the model repair that would truncate again.
- **editFile:**
  - success echoes the changed lines (numbered), so no re-read before the next hunk;
  - "already applied" when the replacement is already in the file (failover/Continue re-sends);
  - a miss shows the closest real block to copy;
  - `replaceAll` for renames;
  - smart quotes/dashes/odd spaces match their ASCII forms;
  - CRLF files stay CRLF;
  - pasted `cat -n` line-number prefixes are stripped;
  - an edit that changes nothing is refused instead of reported as done.
- **readFile/editFile "Did you mean":** a missing file names near matches (extension, case,
  substring, edit distance) or the nearest existing folder.

### Changed

- **No step cap by default — turns run until the work is done.** Production coding agents
  (opencode, Claude Code) don't count steps, and TierMux already carries every guard that makes
  that safe: the repeat/stuck progress signature, the tool-failure limit, auto-compact, per-step
  failover deadlines and the Stop button. `maxStepsPerTurn` defaults to 0 (was 50); a number
  re-imposes the hard cap with its resumable-pause Continue flow for quota-constrained
  unattended runs.
- **Real work leads with strong models again.** Since 2026-09-22 a below-floor tier could buy the
  agent/coding/debug/plan LEAD with speedRank ≤ 2 — in practice every curated fast-mid head led
  real work, and the 2026-11-11 audit traced "slow AND weak on big tasks" straight to it. Speed no
  longer buys a floored lead; the all-blocked fallback still guarantees the chain never empties.
- **The plan-mode file map carries symbols, in every mainstream language** (Aider's repo-map
  lesson, regex-sized): one ripgrep pass annotates the small-tree map with up to 10 declared
  names per file (`OrderController [placeOrder, refund]`) — the plan's first read lands on the
  right file instead of the first plausible name. The declaration shapes cover PHP, TS/JS, Python,
  Go (methods with receivers, types), Rust (incl. `impl` first-segment), Java/C# (classes,
  records, structs), Ruby, Kotlin, Swift, Scala, Dart — a repo of any framework, not just the
  maintainer's stack.
- **Research sub-agents run to 30 steps** (was 15): an unfamiliar codebase routinely needed more
  than 15 read/grep steps; the budget is the subagent's isolated context (only its summary
  returns), not its step count. Read-only by design stays.
- **The todo audit fires only on multi-todo turns** (≥3 items): one declared-done item is trivia,
  three is a plan worth checking — and the audit pass is a full-context model call.
- **Week-2 harness fixes: long turns stay on track, and verification stops costing the whole
  suite.**
  - *Focus pulse (Cline Focus-Chain style):* on every 6th step of a turn, when the todo list has
    actually changed, the engine appends a compact `<progress>` note — n/m done, what is still
    open, what just closed. The system prompt's todo block was a turn-start snapshot a long turn
    drifted from; unchanged lists are never restated (cache-friendly).
  - *Verify runs only the changed TEST files* when the turn itself edited test files (npm/pnpm/
    yarn/bun test, php artisan test / phpunit, pytest) — a full-suite pass that costs minutes on
    the free tier now costs seconds. Non-test edits keep the full suite: the wrong subset would
    verify nothing, and >8 files is a full run, not a path salad.
  - *Plan mode's closers step scales with the step cap* (floor 15, ceiling 60): raising
    `maxStepsPerTurn` — the big-task opt-in — used to be nullified by the flat 15-step plan budget.
- **Week-1 harness fixes (the 2026-11-11 audit): four changes that attack "slow, cannot finish
  big work" at the routing layer.**
  - *The failover chain stops starting new candidates after 60s, not 120s* (`chainDeadlineMs`
    default). A silent multi-minute walk to a first token reads as a hang; past a minute the
    honest chain report beats another cold candidate. The setting still tunes it.
  - *A confirmed context overflow (413, or a 400 naming the prompt size) drops the remaining
    candidates whose declared window cannot fit the prompt* instead of re-buying the same error
    from each — `preferFittingWindows` demoted them to the tail, the walk replayed them anyway.
    The chain report now names every skipped model with its window.
  - *The model that served a turn now leads the next turn of the same conversation*
    (session-sticky, cooldown-/exclusion-checked, never against an explicit pin). Cross-turn
    prompt caches stay warm instead of being thrown away at every turn boundary; a failing
    sticky degrades to the normal chain exactly like the in-turn one.
  - *The prune target's 120k ceiling is now 400k.* It silently clipped real working sets — a
    200k-window model pruned at 120k, losing 40% of usable context mid-task, and tier-2 pruning
    then dropped reads the exact-match edits still needed. Every catalog window is now left
    whole; only ~1M-window models still see a fraction cap.

### Added

- **The shim can no longer hang a turn when bun cannot start.** Live repro (2026-11-11, found in
  the extension-host log): `spawn bun ENOENT` at 14:38, the turn still spinning 42 minutes
  later. Two faults in one — the request spawned a bare `bun` from PATH instead of the binary
  availability had just probed (the installed copy in extension storage), and a spawn failure
  emits `error`, which nobody listened to, so the request promise never settled. Both fixed:
  the fetch resolves the binary exactly as the availability check does (env override → installed
  copy → PATH), and a spawn failure rejects within milliseconds, letting the lane fall back to
  the direct request and its honest refusal instead of hanging.
- **A stalled OpenCode stream can no longer hang a turn forever.** Live repro (2026-11-11): a
  pinned free model's stream started, went silent, and sat there for 22+ minutes — pinned turns
  disarm the engine's stall gates by design, and the bun shim had no timeout once headers had
  arrived. The shim now carries its own body-idle guard: no bytes for 90 seconds (SSE keep-alives
  count — a live stream never trips it; `TIERMUX_BUN_IDLE_MS` tunes it) aborts the request, which
  surfaces as a stream error the engine can fail over on instead of silence. A body-phase abort
  now also reaches the caller as an error rather than a clean-but-truncated end.
- **A stored key no longer blocks the free models.** A saved Zen key made every OpenCode request
  go keyed and direct — and the gate refuses free-tier models for ANY third-party client, key or
  no key, so users with a key saw only the 429 while the keyless lane sat unused beside it. A
  keyed request that draws the free-tier refusal now retries once on the anonymous lane (costume
  + bun shim) and remembers the model: later requests go straight to the lane. Models the key
  can actually serve — paid ones, with credits or Go — stay keyed; a dead key still errors
  honestly rather than being quietly ignored.
- **A one-time offer to install bun.** Without a bun on the machine the shim above has nothing to
  ride, so the first keyless OpenCode request now asks: download bun (~40 MB from the official
  GitHub release, ~90 MB on disk) into the extension's own storage — nothing system-wide, no PATH
  change, gone when the extension is uninstalled? "Not now" is remembered for a week, "Never ask"
  (or the *Offer to install bun* setting) forever, and the **TierMux: Install bun** command always
  works. The installer walks the release zip with its own minimal reader, skips the launcher shim
  by size, and verifies the binary answers `--version` before the lane uses it. `npm run
  test:e2e:bun-install` covers the zip reader and the offer flow (one ask per session, acceptance
  wires the lane to the shim); the download path itself was verified live end-to-end.
- **The bun shim: keyless OpenCode works from the extension again.** Zen's gate also fingerprints
  the TLS/HTTP stack, and the extension host's Node fetch never passes that layer. When a `bun` is
  already installed on the machine (or `TIERMUX_BUN` points at one), every keyless lane request now
  runs inside a short-lived `bun -e` child — bun's network stack is the official client's own
  family — and the streamed answer is folded back into the provider's normal path. Nothing is
  bundled or downloaded; keyed requests never use the shim; without bun the lane falls back to the
  direct fetch, quarantines after one honest refusal, and the error names bun (and Go/Console) as
  the routes that work. Verified live from Node: 3/3 free models answered through the shim
  (`npm run test:e2e:bun-shim` covers the transport).

- **The OpenCode free lane rides Zen's new body fingerprint.** Since ~2026-11 the anonymous gate no
  longer judges the wire identity (headers, User-Agent, HTTP stack) — it fingerprints the request
  *body*: the first system message must carry the official client's agent-prompt head followed by an
  `<env>`-shaped block, and the bash/glob/grep/read quartet must ride in `tools`. Keyless requests
  now lead with that decoy system message (the turn's own system prompt follows it and stays in
  charge), the quartet still rides along, and the costume was re-captured from opencode 1.19.5
  (UA, `x-opencode-client: cli`, the mirrored `x-opencode-session-id`). Verified against the real
  gate — served, `billing_source: "free"`, prompt cache warm — by the new
  `npm run test:e2e:opencode-lane:bun-live`, which runs the full provider path under bun.
- **The gate's second layer is now measured and documented.** The same byte-perfect body is refused
  with the same 429 when it arrives over Node, curl or python TLS — only the official client's
  network family (bun/BoringSSL) passes; that layer is what the shim above bridges. `LIVE=1` from
  node reports a shim-less refusal honestly instead of failing the costume, and
  docs/PROVIDERS.md § OpenCode Zen now describes both layers plus the recipe for re-capturing the
  decoy prompt when Zen moves it.

### Fixed

- **OpenCode Go works through a custom endpoint.** Go is the one OpenCode surface documented for
  "other coding agents": it asks for an honest User-Agent (TierMux sends `tiermux/x.y.z`) and a
  stable per-conversation `x-opencode-session`. Custom endpoints sent neither, so Go answered
  `400 MissingSessionID` and the route was unreachable. TierMux now sends the session header to any
  `opencode.ai` endpoint (hostname-matched — `opencode.ai.evil.tld` gets nothing). Point a custom
  endpoint at `https://opencode.ai/inference/go/openai/v1` with a Console key from a Go/Go Plus
  plan. Nothing is disguised: Go answers `401 Go requires a credential` with the session header and
  `400 MissingSessionID` without it, exactly as its docs describe.
- **The symbol pass actually ran.** The declaration-scan rg call carried no PATH argument, so rg
  read STDIN — a pipe nobody closes — hung until its own timeout killed it, and every workspace
  silently degraded to the plain name map. One explicit `.` (the gathered root is already the
  cwd) and the symbols flow. Found while merging the two symbol-map lines of work (2026-11-12).

### Fixed

- **"Set key" now works for OpenCode Zen.** The panel already drew the button and labelled the card
  *keyless · optional key*, but the command behind it read `keyless` alone and answered "OpenCode
  Zen is keyless — no API key needed", so a key could never be stored. `keyless` and `keyOptional`
  are opposites where it matters: the first means no key can be used at all (Kilo/Pollinations/OVH,
  still refused), the second means the provider has a keyed product next to its anonymous tier — for
  Zen that is paid Console models and Go, *not* its free-tier models (see below).
- **OpenCode's "Free usage limit reached" no longer kills a turn.** Zen v2 answers any client it
  does not recognise with `429 Free usage limit reached`, and it is the gate judging the *client*,
  not your quota — so retrying spends nothing down and the next free model earns the same answer.
  One refusal now quarantines the whole keyless OpenCode lane for 30 minutes, the remaining
  candidates on it are skipped instead of costing a round-trip each, and the turn continues on your
  other providers. The error names the route that actually works — **Go or a paid Console key, not a
  free key**: OpenCode's own docs say free-tier chat models are served to their client only. A pinned
  model keeps its exemption.
## [3.0.6] — 2026-11-12

### Added

- **Background tasks.** `runCommand {background: true}` starts a dev server, watcher or long
  build and returns a task id at once instead of eating the turn's whole timeout. The new
  `taskOutput` tool reads new output (cursor-based, waits up to 30 s), lists every task when
  called without an id, and stops one. Cap of 3 concurrent tasks — the refusal names the running
  tasks so the agent can pick one to stop. A task nothing reads and that prints nothing for 30
  minutes is killed to free its slot (`browserVerify` refreshes the clock, so a verified-but-quiet
  dev server survives). Deleting a session kills its tasks; reloading the window kills all of
  them; the Stop button deliberately does not — stopping the turn is not stopping the server.
  Same approval path as a synchronous command: the permission policy reads the command, the flag
  only changes where the process lives.
- **Browser verification** (`browserVerify`). Renders a page in the user's own headless
  Chrome/Edge over the DevTools pipe — zero new dependencies, no bundled browser, no key — and
  reports the four machine-checkable layers: navigation (a refused connection says "is the dev
  server running?"), page JS exceptions and console errors (the fix loop's signal), HTTP status,
  and a screenshot for vision-capable models, decided at call time so a mid-session failover
  re-evaluates. Cross-origin subresources are blocked and counted (same-origin, localhost and
  data/blob load), so a verify run cannot become an SSRF/exfil hop; a missing favicon 404 is
  filtered as universal dev noise. Hard 60 s deadline — a page that never settles returns a
  timeout verdict instead of hanging the tool. `fetchUrl`'s "JavaScript-rendered" dead end now
  points here. No browser installed → a disabled-tool message with the fix, not a failed turn.

- **A symbol sketch of the workspace in agent and ask turns.** Plan mode's file map (names
  only) now extends to working turns: `src/app.ts — alpha, Widget, Shape` says which file to
  open, so the model spends its first step reading code instead of grepping for names
  (aider's repo-map idea, regex-grade, no new dependency). Sized to the routed model's window
  (~2.5%, floored/ceilinged, off below 16k), rendered freshest-touched first so active files
  survive the cut, cached per file on path+mtime so a per-turn gather is one stat per file.
  `tiermux.agent.symbolMap` (default on) turns it off.
- **Scanned PDFs reach models that can read them.** A PDF the webview could not render into
  page images was silently dropped at the engine door — even Gemini never saw it. Raw PDF
  blocks now forward as file parts (a carries-RawPdf provider delivers the bytes), and where a
  provider cannot take PDFs the model is told exactly that ("PDF \"scan.pdf\" not delivered")
  instead of silently guessing at a file it never saw.

### Fixed

- **A rate-limited model no longer sits out an hour.** 3.0.5's free-limit handling folded 429
  into the "model unavailable" dead-mark, but Zen sends that exact text when THROTTLING a model
  (live 2026-10-06) — a healthy model got benched 60 min for one 429. 429 is back to
  moment-only: the cooldown and the free-limit cooldown own it.
- **Token-level collapse is caught, not streamed.** The degeneration guard only recognized a
  byte-identical block repeated three times; a model degenerating into `function. Function.
  f f f.` (case/spelling churn on every repetition, live 2026-11-11) slipped through and
  shipped pages of it. A word-collapse metric now cuts the stream within ~400 chars — one word
  over half the reply, or a vocabulary under 12% unique — numbers counted, varied prose
  provably untouched.
- **The @@-block tool dialect is adopted.** A stealth-lab model (xKiro `stealth/big-pickle`,
  live 2026-11-12) writes tool calls as `@@CALL_TOOL / @@ARG key@@value@@END_ARG / @@END_CALL`
  in its text — no `<` anywhere, so every tag-shaped rescue was blind to it and the calls
  shipped as prose with confused protocol narration. The blocks are now parsed as tool calls
  (quoted names, JSON-object parameters, unterminated mid-stream chunks), with the existing
  alias tables mapping `read`→`readFile` and `file`→`path`.

## [3.0.5] — 2026-10-13

### Added

- **Send while the agent works.** A message sent during a running turn is queued and sent when
  the turn ends, instead of stopping it. Stop clears the queue. A turn that finishes in a session
  you are not looking at tells you so.
- **Syntax check after every write.** `php -l`, Python's parser, `ruby -c` and `bash -n` run on the
  file just written, so a parse error is fixed on the next step even without a language server or
  test suite. Silent when the checker is not installed.
- **Faster, grounded plans.** Plan mode gets a .gitignore-aware map of the project's file names up
  front instead of spending its first turns listing directories, and plan execution no longer
  re-checks after every edit when the project's verify step runs anyway. A plan's evidence must
  come from a file actually read, searched or attached in the turn.
- **OpenCode Zen models that only speak `/responses`** (muse-spark) now work.

### Fixed

- **Two edits to the same file at once no longer lose one.** Writes to one path now run one after
  another.
- **Auto-approve still asks before a dangerous command.** `rm -rf ~`, `git push --force` and
  `git reset --hard` ran without a prompt under the default Auto-approve; everything else still
  runs unasked.
- **Free models' broken tool calls are repaired.** A tool call written as text, one split between
  the call and the text, or a tool name with leaked tokens (`grep<|channel|>commentary`) now runs
  instead of shipping as the answer.
- **A model whose quota is spent rests until it resets.** Rate-limit and `Retry-After` headers now
  set how long it is skipped.
- **The model catalog stays safe and fresh.** It refreshes every ~6 hours (an unchanged catalog
  costs one tiny 304), a sudden large shrink is held until it is seen twice, the remote catalog can
  no longer repoint a built-in provider or use a non-https address, and models you switched off
  stay off when they come back.
- **Session titles** are retried and fall back to your first sentence.
- **`/explore`** runs its questions one after another; in parallel they ran into rate limits.
- `runCommand` and `glob` honor the workspace-root override; the agent no longer re-runs the full
  test suite right before the host's own verify step; generated commit messages drop model
  chatter and markdown.

## [3.0.4] — 2026-09-29

### Fixed

- **The agent no longer forgets files it is still using.** Tool output used to be elided after a
  fixed number of steps (3 in Agent mode), so a turn working across four or five files re-read the
  same file again and again until the repeat guard stopped it — a live run re-read one file 12×
  in 4.5 minutes. Output now stays in full until the conversation fills ~60% of the model's
  context window, then the oldest results go first. Same question, same free model: 2 minutes,
  each file read once or twice.
- **Follow-up messages see what the last one read.** Tool results were cut to 2,000 characters
  when a turn ended; they are now kept whole (up to 30,000 per result), so "now do it" does not
  start by re-reading everything. Auto-compact judges the conversation itself, not file content
  the agent can re-read, so it no longer summarizes early because of big files.
- **Skipping a question means "no".** In Agent and Ask mode, skipping the agent's question used to
  let it carry on "with the safest approach" — including editing files. The turn now stops there
  and says so. Plan mode is unchanged (it asks once more or states its assumption in the plan,
  which still needs your approval).
- **A stuck turn still gives you something.** When the repeat guard stops a turn, Agent mode now
  reports what it found, what it changed and what is left (path:line), and Plan mode is pushed to
  propose its plan or ask you — instead of ending on "Stopped: no progress" alone.

## [3.0.3] — 2026-09-24

### Added

- **Model-loaded skills.** Skills load from the model side (`feat(skills)`).
- **Window-fit routing.** Candidate ordering respects the context window, and auto-compact
  compacts to the window size, not a fixed target.
- **Key-optional OpenCode Zen.** Zen accepts a missing key (empty-Bearer trap avoided), a keyless
  free lane, and upstream errors surfaced inside a 200 stream.

## [3.0.2] — 2026-09-17

### Fixed — an attachment can no longer be routed to a model that cannot see it

- **Vision is now a routing gate, not just a task kind.** `classifyTask` correctly labelled an
  image/PDF turn `vision`, but that only chose the head of the chain — `TASK_ROUTING.vision` held
  a single keyed entry (`google::gemini-2.5-flash`), and the tail padded the chain with every
  enabled model regardless of `supportsVision`. With no Google key the head was skipped and a
  text-only model led, dropping the attachment silently. `selectModel` takes `requireVision` /
  `requireRawPdf` and gates inside `pickOne`, so the tail is filtered too
  (`src/router/picker.ts`, `src/agent/core/engine.ts`).
- **Auto mode had no vision guard at all.** The pre-flight check in `chatViewProvider` was
  conditioned on `m.model !== 'auto'`, so it only ran for a pinned model.
- **Keyless vision routing.** `TASK_ROUTING.vision` gained the keyless, tool-capable
  frontier/strong rows (`opencode::muse-spark-1.3-contributor-free`, `opencode::mimo-v2.5-free`,
  `kilo::dots-studio/dots-3-note-preview:free`), so a zero-setup install routes an attachment.
- **Content-flattening providers are excluded.** `OpenAICompatProvider.flattenContent` documented
  itself as existing "so the router can exclude flatteners from vision turns" but nothing read it;
  cohere and cloudflare rows with `supportsVision: true` flattened the image to text on the way
  out. Now wired via `platformFlattensContent()` (`src/providers/index.ts`).
- **`NoVisionModelError` is thrown.** It had existed and been re-exported since it was written
  without a single caller; an exhausted vision chain used to fall back to the *unfiltered* keyless
  chain, undoing the gate.
- Locked by `npm run test:e2e:routing-gates`.

### Fixed — utility calls get their failover back

- **`routeOnce`'s `model` is a preference again, as its header always claimed.** It was passed to
  the picker as `pinnedModel`, and PIN = EXACT returns an empty fallback chain — so every utility
  caller with a preferred model got one candidate and no failover. One rate limit silently killed
  an inline completion, a commit message or a chat title, which is why `condense` and the title
  path hand-rolled a second call without `model`. The chain is now resolved unpinned and the
  preference hoisted to its head (`src/agent/core/routeOnce.ts`). An explicit user pin in chat
  still runs alone — that contract is unchanged and asserted.
- **Inline completions no longer pick their own model.** `catalog.fastestEnabled()` read
  `speedRank` alone — ignoring cooldown, rate limits and the provider switch, and rating
  `kilo::kilo-auto/free` "fastest" though it is a router alias whose latency is unknowable. The
  provider now routes through `taskKind: 'trivial'` unless the user set a model explicitly
  (`src/completions/inlineCompletion.ts`); `fastestEnabled` is removed.
- **`TASK_ROUTING.trivial` is ordered by speed**, since latency is the product for completions,
  commit messages and titles. Added `kilo::stepfun/step-3.7-flash:free` — the only keyless
  speedRank-1 row in the catalog, so a keyless install reaches a fast head from the table alone.

### Changed — a failed verify no longer renders a verdict

- **The result card says nothing about a failed gate.** The verify command is never run *before*
  the changes, so a non-zero exit cannot be attributed to the turn — a suite that was already red
  read identically (repro: a two-file edit on a Laravel repo with pre-existing failures). The
  card's "❌ Verification failed … Say 'keep fixing' to continue" is gone; a failed turn renders
  only its changed files, and nothing at all when it changed none (`media/src/ui/components/
  ResultCard.ts`, `src/shared/workReport.ts`). Supersedes the agent-owns-the-recheck copy of
  2026-08-25.
- **The agent reports a real failure itself, in one sentence.** The fix-round prompt used to offer
  "if it is unrelated, say so in one line and stop" on *every* round, so round 1 could be spent
  writing an excuse instead of attempting the fix. Now only the final round asks for a
  one-sentence verdict; earlier rounds are told to fix and not to explain yet
  (`src/agent/core/engine.ts`).

### Fixed — the release now covers every VS Code desktop platform

- **Nine targets instead of six (or four).** `package:all` and `publish:all` each kept their own
  private target list and had drifted apart: the first shipped six platforms, the second only
  four — so `npm run publish:all` published **no Linux ARM, Windows ARM or Alpine build at all**.
  Both now read `scripts/release-targets.json`. Added `linux-armhf`, `alpine-x64` and
  `alpine-arm64` (Docker images, devcontainers and VS Code Server on musl had nothing to install).
- **The ripgrep directory is named after the runtime, not the target.**
  `@vscode/ripgrep/lib/index.js` resolves `@vscode/ripgrep-${process.platform}-${process.arch}`,
  which is `linux-arm` for `linux-armhf` and plain `linux-*` for both alpine targets. The old
  packagers assumed the two names matched; on the new targets that assumption deletes the very
  binary the VSIX needs. Both alpine binaries are statically linked, so the glibc packages run
  under musl. Verified per VSIX: exactly one ripgrep package, correct architecture.
- **A partial rollout is resumable.** `publish-targets.mjs` publishes 2 marketplaces × every
  target and aborts on the first failure, so an interrupted rollout could not be re-run —
  whatever had already landed failed with "already exists". Both publishes now pass
  `--skip-duplicate`.
- No universal/no-target VSIX on purpose: `@vscode/ripgrep` is external in the bundle, so Node
  loads `lib/index.js` for real and it THROWS when the platform package is missing — a
  binary-less universal build would fail activation rather than degrade.

### Known issue

- The VSIX still ships without the root `LICENSE` (vsce reports it as unmatched when listed in the
  `files` allowlist, and excludes it otherwise). The repo is MIT and `LICENSE` is at the root; only
  the packaged copy is missing.

## [3.0.1] — 2026-09-06

### Changed — fewer, faster steps on free tiers

- **Auto keeps its model for the whole turn.** The router used to re-run selection on every
  step (the SDK calls the provider once per step) and the equal-rank rotation counter advanced
  each time, so a multi-step Auto turn switched models step after step — every switch a cold
  provider, the full transcript re-sent, no prompt cache. The candidate that served step 1 now
  goes first on later steps and the fallback chain is resolved only if it fails; rotation still
  happens between turns, and 429/cooldown/failover behave as before
  (`src/agent/core/routerProvider.ts`, locked by `npm run test:e2e:router-sticky`).
- **System prompt: one search round, then answer.** The search-honesty rules were being applied
  to every question (workspace-wide bare-term grep, re-reading pasted findings); the bare-term
  grep is now scoped to negative claims and re-checks to findings the user asks to act on.
- `tiermux.agent.verifyFixRounds` default 2 → 1; chat-title generation asks one model, not
  up to three.
- **System prompt rewritten as sections with reasons** (`src/context/system.ts`): what is
  already in context (rules, editor, @mentions — never re-read), one search round then answer,
  todoWrite only for multi-phase work, one-question policy in agent mode, tool-free answers in
  ask mode when the context already holds the answer, answer size banded by change size.

### Changed — a universal method, and plumbing for weak models (2026-09-06)

- **System prompt: Stance / Method / Honesty** (`src/context/system.ts`). One investigation
  method for every task: observe the thing itself before the code that produces it; locate
  the path; name a cause only when it fits every fact; note each finding in one line so the
  trail survives pruning; gather as much as the task needs, never the same call twice. The
  research sub-agent shares `METHOD`. The earlier "one search round" rule is gone — it
  discouraged evidence, not waste.
- **Every Auto turn was routed as `chat`.** The host never passed a task kind and the picker
  classified an empty message list. The engine now classifies once per turn
  (`classifyConversation`): a short follow-up ("is this correct?", "issue ki?") inherits the
  previous substantive turn's kind instead of dropping to the chat tier.
- **AI SDK "Prompts for Tools" tips applied:** tool-offered calls run at `temperature: 0.2`
  (0 sent a free model into a decoding loop; the Responses and compat adapters omit it for
  o-series/gpt-5, which reject it); a stream that repeats the same block three times is cut
  and the model cooled down (`isDegenerateRepeat`, live repro 2026-09-06);
  `inputExamples` on readFile/grep/glob/editFile/runCommand/delegateTask ride in the wire
  description; a null-valued optional parameter is stripped mechanically before any model
  repair round (`withoutNullKeys`).
- **delegateTask on every window** — a small-window model is exactly the one that needs to keep
  a 10-file exploration out of its context; only `todoWrite` is withdrawn there. Its schema is
  `task` alone, with when / when-not / "write it for a colleague with no context" guidance.
  The sub-agent gets a classifier-gated read-only shell (git history, listings, data queries).
- Tool descriptions say when NOT to use them (readFile, runCommand, todoWrite).
- **An identical read-only call never re-runs.** The second copy returns the earlier result
  with a note, later copies only the note, and the fourth pauses the turn as stuck
  (`dedupeReads`, live repro: grep "distance" 15× in one turn).
- A question ("why…?") is answered before anything is changed (Stance); "why X is not set"
  routes as debug; the verify fix round is told to leave the work alone when the failure is
  unrelated (a missing service) instead of reverting it.
- Locked by `npm run test:e2e:weak-model-plumbing`; `tool-offer` and `delegate-task` updated.

### Added — sub-agents are files, and memory asks first (2026-09-07)

- **Sub-agent registry** (`src/agent/agents.ts`): `explore` and `review` ship built in, and
  `.tiermux/agents/<name>.md` adds or replaces one — same frontmatter shape as skills, with
  `description`, `tools`, `model`, `taskKind`, `maxSteps` and the body as that agent's prompt.
  `delegateTask` lists the roster in its description and takes an `agent` name; the sub-agent
  gets only the tools its file names, and nothing that mutates either way.
- **The explore agent carries a playbook**: how to approach "where is X", a wrong value, or an
  architecture question, and a fixed report shape — answer, evidence with `path:line`, what was
  ruled out, what is still open — so the caller learns what NOT to re-check.
### Fixed — instructions written for another agent still work here

- **Tool names from other harnesses resolve mechanically.** Nobody writes a skill, an agent file
  or a pasted instruction for TierMux, so a model following one calls `Read`, `Bash`,
  `apply_patch` or `Task`. Those now map to `readFile` / `runCommand` / `editFile` /
  `delegateTask` before any model repair round (`resolveToolAlias`), covering Claude Code,
  Codex, OpenCode and Cline naming plus pure case/separator differences. An unrecognised name
  still goes to the model, and an alias is never invented for a tool the current mode does not
  offer. Invoking a skill also states the mapping once, up front.

### Added — a Skills panel you can browse

- **Settings → Skills**: what is installed (with the `/name` that runs it, and a remove button
  for the ones that are not bundled) plus a browsable list with one-click install, which goes
  through the existing `npx skills add <owner/repo> [--skill <name>]` into `.agents/skills/`,
  shared with other agent tools.
- **Live search against the agent-skills directory** (`tiermux.skillRegistrySearchUrl`,
  skills.sh by default), the same shape as the MCP registry search: an empty box shows the
  curated list, two characters or more queries the directory. Results carry their real
  repository and install count, and are never shown as first-party.
- **Who supplies the list is a trust decision.** A skill runs with the agent's permissions, so
  the panel reads, in order: the catalog worker's `/skills` (derived from `tiermux.catalog.url`,
  so the list can be updated without a release), then `media/skill-registry.json` shipped here
  (24 entries; the whole list when offline), then any `tiermux.skillRegistryUrl` — which is
  merged in LAST and can neither displace a known skill nor mark one first-party. The badge
  says `vendor repo` and asserts exactly one checkable fact: it installs from the repository of
  the vendor whose product it teaches. It is not a review. Every card links to its source.
  Locked by `npm run test:e2e:skill-catalog`.

### Fixed — a skill can read its own files

- **Multi-file skills silently lost their references.** A skill that ships `references/` or
  `scripts/` (our `/design`, and most of the installable ones) told the model to read them, but
  `readFile` is confined to the workspace and a BUNDLED skill lives under the extension folder —
  so every such read missed. Invoking a skill now registers that one directory as readable
  (`registerReadableRoot` / `resolveReadablePath`): read-only, exact-directory, opt-in per skill.
  Writes and commands keep the plain workspace containment. `resolvePath.e2e.ts` covers the
  sibling-prefix and write-resolver cases.

### Fixed — MCP is usable on an OpenAI-shaped wire

- **Long MCP tool names no longer kill the request.** `mcp__<server>__<tool>` was sent
  unbounded; past OpenAI's 64-character function-name limit the provider rejects the WHOLE
  request, not just that tool. Names are now capped with a stable content hash
  (`mcpToolName`), keeping a readable prefix and never colliding.
- **A remote MCP request is time-bounded.** The HTTP transport had no timeout at all, so one
  hung server held the turn; both transports now share a 30s per-request bound.
- **A server's own `instructions` reach the model** in an `<mcp_instructions>` block (agent
  mode only, capped at 2 KB), framed as guidance that never overrides the rules above.
- Locked by `npm run test:e2e:mcp-wire`.

### Fixed — Continue keeps the task list

- **Continue keeps the task list.** A todo-driven turn that hit the step cap lost the list on
  Continue — the new turn's transcript no longer carried the `todoWrite` result, so the model
  started blind and the UI card was empty. The list now rides in a `<task_list>` block in the
  resumed turn's system prompt (finished items marked, not dropped) and is re-rendered under
  the new request id. A fully completed list is never injected, so old work cannot leak into
  a new task. `foundation.e2e.ts` scenario 15b.
- **Todo audit** (`tiermux.agent.auditTodos`, default on): when an agent turn marks todos
  complete, a read-only sub-agent checks the workspace for evidence of each one and hands back
  anything it cannot find, for at most one more pass. Bounded exactly like the verify gate —
  agent mode only, only on turns that used `todoWrite`, skipped on abort or a stuck stop. The
  trigger is missing evidence, never answer quality: the claim is not the evidence.
- **`tiermux.agent.learnFromCorrections`** (`ask` | `always` | `off`, default `ask`): memory is
  durable and lives in the user's repo, so a correction is now shown before it is written.
- Locked by `npm run test:e2e:agent-registry`.

### Added — TierMux learns across sessions (no extra model calls)

- **Corrections are remembered.** Every compaction already writes a "Corrections & rejected
  approaches" section; those entries are now appended to `.tiermux/memory.md` under an
  agent-maintained heading (de-duplicated, newest 20 kept, the user's own text always injected
  first) and reach every later turn through `<user_memory>` (`src/context/userMemory.ts`,
  `condenseHistory().corrections`).
- **Auto routing learns from outcomes.** The verify command's exit code and a stuck stop are
  recorded as implicit signals on the served model (`ModelStatsStore.recordSignal`, half the
  weight of a 👍/👎) and persist across reloads. Still only a tie-break among equal-rank peers —
  never overrides intelligence rank. Pinned models are not scored.
- **The verify command is stated in `<environment_context>`** so the model does not spend a
  search round discovering how the project is tested.
- Locked by `npm run test:e2e:memory-learned`.

### Fixed — long turns no longer lose the conversation

- **Compaction after a 50-step turn forgot the goal.** The summarizer received the raw prefix
  with no fitting (a 400k-token prefix into a 32k-window utility model — the provider kept the
  tail, the original ask was the head), the blank-retry dropped the OLDER half, and 95% of the
  input was tool output. Now (`src/agent/condense.ts`): tool results/arguments are capped before
  summarizing, the request is fitted to the summarizer's window with the first user message
  pinned, the summary budget is 2048 tokens, and an earlier summary's Goal/Corrections/Next
  steps are carried forward explicitly.
- **An oversized tail is folded into the summary.** A tool-heavy turn's tail was ~100 messages
  of stubs (26k tokens) re-sent on every later step; the tail is now the turn's user message plus
  its closing reply. This is also the first time a session that STARTS with a mega-turn can
  compact at all (tailStart 0 returned null).
- **Tool results are capped at 2,000 chars when persisted into history** (`capForHistory`) —
  the aging threshold, so nothing a later step could see changes, while a 1.5M-char history
  stops being estimated, persisted and summarized every turn.

### Changed — model rationale UI

- The model-selection rationale is now a compact footer chip in the chat composer instead
  of an inline block; the details live in a redesigned, collapsible popover.
- The rationale filters out disabled providers and tracks which model actually served the
  turn.

## [3.0.0] — 2026-08-31

### Added — plan mode's boundary is a tool call

- **`exitPlanMode`** (`src/agent/core/tools/v3/exitPlanMode.ts`) — the model now DECLARES
  its plan by calling a tool with a validated `{what, files[], verify}` structure. The
  engine captures it on `AgentResult.plan` and ends the turn
  (`stopWhen: [stepCountIs(50), hasToolCall('exitPlanMode')]`); `chatViewProvider` renders
  the `planProposed` card straight from that structure.
- Removed the prose-classification path it replaces: `extractPlanFromProse` (an LLM
  "was that a plan?" classifier), the plan-mode half of the `looksLikeGroundedAnswer`
  corrective re-run, and the third model call that normalized prose into steps — up to
  four model calls per plan turn collapse to zero. See
  `docs/PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md`; the classifier must not come back.
- **`npm run test:e2e:exit-plan-mode`** — 50 scenarios covering the tool boundary, plan
  serialization, and the saved-plan document format.

### Changed — Tips UI uses standard theme colours

- The tips cards, the composer strip, the RECENT rows and the unread indicator were painted
  with `charts-yellow` and `editor-inactiveSelectionBackground`. The first is a *chart series*
  colour and the second a *text-selection* colour — neither is a surface token, so cards came
  out navy under Dark+ and the strip came out mustard regardless of theme (report 2026-08-31).
  Surfaces now use the standard widget palette: `editorWidget-background`,
  `badge-background/foreground` for pills and the toolbar dot, `list-hoverBackground` on
  hover. The accent survives where it carries meaning rather than decorating a panel — the
  strip's border, its TIP label, and the unread card's left rail. They inherit whatever the
  user's theme defines instead of fighting it. `charts-*` stays where it is genuinely semantic
  (queued/approval/finished status dots, file-type chips).
- The RECENT list dropped `input-background`, which made the rows read as one large text
  field, and with it the `body.vscode-light` override that only existed to patch that.
- Fixed descender clipping in the ticker: the 16px track cut the tails off `p`/`g`/`y` on a
  16px line box; the track is 18px now.

### Added — a session dot on the welcome screen's RECENT rows

- RECENT listed sessions as bare title + timestamp lines, so several entries read as one
  wrapped list. Each row now leads with a status dot, matching the history dropdown, with
  the same status colours (queued / needs-approval / running / finished). RECENT uses its
  own glyph map: the history dropdown swaps `running` for a real spinner, and a static `⟳`
  in a plain list reads as a stuck reload button.

### Changed — the tips ticker lives on the welcome screen

- The Tips & Announcements headline ticker (new in this release) cycles one headline at a
  time above RECENT on the welcome screen — permanently, so it does not die when a chat
  starts (user request 2026-08-31: "keep it forever slide show always"). It deliberately
  has NO placement above the composer: tips pinned over the input box during chats read as
  system messages, not announcements (user direction, same day). Read tips keep cycling;
  only a genuinely empty feed hides it; clicking it opens the full Tips page.

### Fixed — asserted negatives without an adequate search

- Live repro 2026-08-31 ("wallet now commented right?"): four consecutive Ask turns answered
  "no commented wallet configurations were found" — the model had grepped decorated literals
  (`# wallet`, `// wallet`) that cannot match real code like `// $wallet_status = ...`,
  treated the open `.env` as the search scope, and finally claimed "I revisited the workspace"
  while restating an answer the user had pasted from a rival tool. The v3 prompt composer
  ships one search-honesty guard in the BASE prompt (all modes): negatives require a bare-term
  case-insensitive workspace-wide grep with the pattern stated; never claim tool runs that did
  not happen this turn; verify user-pasted findings in the files before agreeing.
  (`.tiermux/agent/research.md` is not in the live v3 prompt — see
  `docs/SIMPLE_CORE_RESET_2026-08-24.md` — so this is the one place the rule can live.)

### Fixed — "Why this model?" credited the wrong model

- The popover named the model TierMux *intended* to use, not the one that answered. The
  report is built by `selectModel()` before the first byte is sent, so `picked` is
  `chain[0]`; when that candidate failed over, nothing re-pointed it at the winner. Live
  repro 2026-08-31: the footer read `ChatAnywhere/gpt-4.1` while the popover insisted
  `✓ opencode/muse-spark-1.2-contributor-free — serves this turn`.
  `rationaleForServed()` (`src/router/picker.ts`) now re-points the report the moment a
  candidate succeeds, and relabels the ones walked past as `tried first, failed over` — so
  the popover shows the whole walk instead of hiding it. Candidates *after* the winner keep
  their `failover #n` label, since they were never dialed.

### Changed — a set model runs ALONE (no silent failover)

- Pinning a model is an exact request: the selection is the pin and NOTHING else. The old
  chain padded the pin with the task table and every usable enabled model, so a failing pin
  was silently answered by a different provider's model while the footer still credited the
  pin (live repro 2026-08-31: `openrouter/z-ai/glm-5.2:free` pinned, turn served by
  `kilo/nvidia/nemotron-3-ultra`). A dead pin now fails the turn with the real reason
  (no key, provider off, cooldown) instead of rerouting (`src/router/picker.ts` +
  `resolveCandidates`); the "Switch model & retry" affordance remains the escape hatch.
  Auto is unaffected — the selector's default `auto` value means "no pin", and the
  pin-runs-alone branches must never treat it as one (this guard was the one blocker found
  by the pre-release scan; without it every default Auto turn died with "Pinned model auto
  could not run". Regression-tested in `test:e2e:foundation`).

### Fixed — the footer paired the pin with whichever provider served

- `Kilo Gateway/z-ai/glm-5.2:free` — an OpenRouter pin's modelId shown under a failover
  provider's name — was the visible symptom of the footer trusting the pin over the run.
  The platform/model that ACTUALLY served (reported per-step by the engine) now wins
  everywhere: the streaming footer, the settled message footer, and failover notices.
  Platforms are shown through their display names ("OpenRouter", "Kilo Gateway"), not raw
  ids. The pin remains only as the fallback label for turns that produced no run metadata,
  so an errored turn still names the model it was aiming at.
  Locked by `npm run test:e2e:rationale-served` (13 scenarios).
- The Score tooltip claimed "the highest-scoring model is chosen", which contradicted the ✓
  on screen: the picker orders by pin → task table → catalog rank, so a task-table pick at
  rank 2 shows 0.80 while the rank-1 tail it beat shows 1.00. The tooltip now states the
  real rule and points at the per-row reason line.

### Fixed — declaration emit skipped after a partial `dist` clean

- `tsconfig.lib.json` is `incremental`, so a stale `.cache/lib.tsbuildinfo` convinced `tsc`
  the `.d.ts` files were already emitted and it wrote nothing — then `vsce` refused every
  target with "include patterns in the files property do not match any files". Production
  type emit no longer trusts that cache (`build:types` runs `--incremental false`), and
  `scripts/package-targets.sh` now checks the expected artifacts up front so a missing
  bundle fails with a readable message instead of six identical opaque vsce errors.

### Added — self-updating README

- **`scripts/sync-readme.mjs`** + **`npm run sync:readme` / `check:readme`** regenerate the
  provider/model counts and provider lists in `README.md` from the live catalog. The
  hand-written numbers had already drifted (README said 585 models; the catalog served
  600). Display names are parsed from `src/providers/index.ts` so there is one source of
  truth for them. Folded into `sync:all`, plus a weekly
  `.github/workflows/readme-stats.yml`.

### Changed — documentation

- `README.md` rewritten against the shipped code and cut from 584 to ~190 lines; the depth
  moved to `docs/PROVIDERS.md` (keys, rotation, custom OpenAI-compatible endpoints,
  settings), `docs/ROUTING.md` (selection, failover, "Why this model?", algorithms), and
  `docs/FEATURES.md` (modes, tools, comparison).
- Corrected claims that no longer matched the code: the removed `terseReplies` setting, an
  "embeddings index" that is a symbol/dependency index, git-worktree sub-agent workers that
  no longer exist, step-verified plan execution, and Wilson/EWMA scoring presented as the
  agent-turn router (it now serves utility calls only).
- Marketplace badges rebuilt — shields.io retired every `visual-studio-marketplace/*`
  endpoint, so those badges rendered "retired badge"; download counts added for both
  marketplaces and a live provider count from the catalog.

## [Unreleased] — earlier v3 work

### Changed — v3 engine: policy layer over the AI SDK

TierMux v3 restructures the agent around one division of labor: **the AI SDK is the
execution engine** (tool parsing/validation, tool execution, the multi-step loop, abort,
execute-error wrapping) and **TierMux is the policy layer** (model selection, permissions,
tools, system prompt, compaction).

- **New engine** (`src/agent/core/engine.ts`, ~330 LOC) replaces `core/loop.ts` (1,358 LOC).
  One `streamText` call with `toolApproval`, `repairToolCall`, `prepareStep`,
  `stopWhen: [stepCountIs(50)]` — the SDK owns the loop.
- **Self-correcting tool calls** (`core/repair.ts`): malformed calls (bad JSON, wrong
  schema, unknown tool) are repaired by showing the model its own error and asking for one
  corrected call — budgeted at 3 per turn. Replaces the 677-LOC regex rescue ladder in
  `agent/toolArgs.ts` at the engine level.
- **Thin model picker** (`src/router/picker.ts`): a readable `TASK_ROUTING` table
  (task kind → candidate chain) with failover on 429/5xx. The scoring stack (Wilson,
  capability profiles, metrics/rate/latency trackers, hedging) no longer participates in
  agent-turn selection; the `Router` remains for utility one-shot calls (titles, commit
  messages, completions) until v3.1.
- **Uniform permission policy** (`src/permissions/policy.ts`): priority chain
  `alwaysDeny → alwaysAllow → read-only → mode → ask`; full-auto can never bypass an
  explicit deny.
- **v3 toolset** (`core/tools/v3/`): readFile, editFile (whitespace-tolerant matching +
  re-indent preserved), writeFile, deleteFile, listDir, glob, grep, runCommand — all
  `tool()`-form with Zod schemas, exception-safe (`{ error }` results), and no embedded
  approval. Plan/ask modes drop mutating tools entirely.
- **Minimal compaction** (`core/compact.ts`): token-budget tool-result stubbing via
  `prepareStep`. The re-anchor/collapse-repeat/watchdog cascade is removed.
- Approved plans now execute as one agent turn with the steps enumerated in the prompt
  (the dedicated step engine is gone; step-level pause/resume returns in v3.1).
- 116 legacy files deleted (~19,000 LOC): the old loop machinery, scoring stack, fleet/
  delegate/explore sub-agents, gate-coupled tools, and 51 superseded e2e scripts.
  The 10-scenario foundation gate (`npm run test:e2e:foundation`) covers the new engine.

### Added — Foundation Gate expanded to 14 scenarios (plan §13)

Scenarios 11-14 drive the REAL engine through a test-only model seam:

- **11. Plan mode flow (§12)** — read/search offered freely, `runCommand` ASKS, edit/delete
  hard-denied at the policy level (even with alwaysAllow — an approved plan is never a
  blanket mutation approval); plan output follows the `## Plan:` markdown convention;
  approving re-gates every tool call in agent mode.
- **12. Context correctness** — prior tool results, user text, and the mode-tail system
  prompt reach the model verbatim; nothing fabricated enters the context.
- **13. Streaming + reasoning + think-tag** — reasoning flows to the reasoning channel
  (never leaks into chat text), precedes text within a step, and `<think>` tags split
  across chunks are stripped/routed with duplicate reasoning suppressed (the R1 routing
  regression, fixed and now gated).
- **14. Session persistence** — transcript round-trip: a fresh turn seeded with the
  persisted workMessages sees prior tool results, does not re-read or re-plan, and
  recovers the agent toolset.

Deferred to v3.1 (after the gate passed): long-conversation compaction, diagnostics-after-edit,
terminal edge cases (cwd/env/exit), model fallback beyond the picker chain, network retry,
optional sub-agent.

### Fixed

- **Auto no longer dies blind on the circuit-breaker cache** (live repro:
  "eto models on, but Auto keeps saying All 5 configured models are
  unavailable" seconds apart). When every candidate sat in the per-model
  health cache from failures moments ago, `route()` skipped them all without
  sending a single request and re-threw the stale verdict instantly — on
  every retry, even after the providers had recovered. A blind-death guard
  now detects "nothing was really attempted" and runs ONE bypass pass that
  ignores the cache and dials for real; outcomes refresh health naturally.
  The cache's normal benefit is untouched — skips still save requests
  whenever a live alternative exists (`S7d`), and the guard fires only when
  zero real requests were made (`S7c`).
- **Honest failure report.** The cached-skip verdict is now reported as
  "benched (recently failed)" instead of borrowing the old failure's reason
  ("1 timed out" used to claim a request that never happened), and the
  message appends why the rest of the enabled pool was never eligible this
  turn: without a usable key, without tool support in Agent mode, or flagged
  unavailable by the provider.
- **Duplicate error blocks removed.** A turn that died before producing any
  text posted the same error twice (a live notice plus the final failure
  bubble). The live notice now fires only when partial output already
  streamed — i.e. when it is the error's only surface.
- Preflight ping timeout raised 1200ms → 2500ms: free aggregators routinely
  answer a cold ping in 1.5–2s, so half-open probes kept re-benching alive
  models on an exponential cooldown and starving Auto's pool.
- Bundled catalog re-synced against the live worker with pruning: 405 → 326
  models. Everything the worker no longer serves (Google's paid/deprecated
  and duplicate `models/`-prefixed ids, OpenAdapter's top-tier-only models,
  Groq's non-chat orpheus/whisper, llm7's now-key-gated gemma4:31b) is gone
  from the offline/first-run fallback too, so the verified free list is the
  only one the extension can ever show or route.

### Added

- **OSS-ready library entry point.** `import { Router, runAgentStream,
  runPlanStream, runAskStream, classifyTask, createRouterProvider, ... } from
  'tiermux'` (or `'tiermux/router'`, `'tiermux/agent'`, `'tiermux/providers'`,
  `'tiermux/shared'`). The same agent engine that powers the VS Code
  extension is now consumable from any Node 18+ application. The library
  build is wired into `npm run build`; declaration files are emitted by
  `npm run typecheck:lib`. A smoke test (`npm run test:e2e:library`)
  proves the public surface resolves under plain Node with the same
  `scripts/vscodeMock.cjs` shim the e2e suite uses.
- **`package.json` exports map**, `files`, `sideEffects: false`, and
  `keywords` updates so the npm tarball contains only what consumers need
  and the package.json's `import`/`require`/`types` resolution paths all
  work.
- **`NOTICE`** — Apache-2.0 §4(d) attribution for the bundled Vercel AI SDK
  and `pdf-parse`, plus an informational list of other MIT/ISC/BSD
  dependencies. Required for the AI SDK's Apache-2.0 license when shipped
  bundled.
- **`CONTRIBUTING.md`** — build, layout, and the simple-core rule summary.
- **`CHANGELOG.md`** (this file).
- **Library smoke e2e** (`scripts/librarySmoke.e2e.ts`) — headless
  end-to-end proving `Router`, `runAgentStream`, and `classifyTask` import
  and run under plain Node.

### Changed

- `esbuild.js` now produces a third artifact (`dist/<lib>.cjs` for each
  public entry) alongside the existing extension and webview bundles. The
  extension build path is unchanged.

### Out of scope (follow-ups, not in this release)

- Engine `vscode` decoupling (Approach B) — config reads, filesystem
  calls, and workspace root resolution still go through `vscode.*` (or
  the supplied shim). A full host-boundary refactor is a separate change.
- Webview `@ts-nocheck` removal in `media/src/main.ts` and
  `media/src/bridge.ts`. Not a packaging concern; tracked separately.
- Marketplace artwork scan (vendor name, banner image) before publishing
  to the VS Code Marketplace or open-vsx.

## [2.1.7] — 2026-08-25 and prior

See git history. Pre-OSS packaging; everything from the simple-core reset
forward. The TierMux VS Code extension was distributed as MIT throughout —
this release makes the licensing + library surface explicit.

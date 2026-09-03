# Polishing streaming tool/reasoning UI toward Codex/OpenCode (2026-09-02)

Research notes + a concrete change list for the tool-call cards and reasoning
blocks in the chat webview (`media/src/ui/tool/ToolCard.ts`,
`media/styles/components/reasoning.css`, `media/main.css`). Written before any
implementation — this is the reference to work from next.

## What Codex and OpenCode actually do

### Codex CLI (`codex-rs/tui`)

Source read: `history_cell/messages.rs`, `exec_cell/render.rs`, `color.rs`,
`ascii_animation.rs`.

- **No cards, no borders, no pills.** Everything is flat text in the
  transcript. Meaning is carried by color, weight, and a couple of glyphs —
  never by boxes.
- **Glyph vocabulary is tiny and consistent**: `•` (bullet, dim — marks the
  start of an agent message or a reasoning line), `›` (bold dim — user
  message), `$` (magenta — a shell command), `✓`/`✗` (green/red bold — exec
  result). That's it. No per-tool icon set.
- **Reasoning text is rendered dim + italic**, full stop — `Style::default().dim().italic()`,
  prefixed with a dim `"• "` bullet on the first line. It reads as the
  model's undertone, not a UI element. No header row, no "Thinking…" chrome
  beyond that.
- **Verbs are bold, targets are plain**: `"Read"`, `"List"`, `"Search"`,
  `"Exploring"`/`"Explored"` render bold; the file/query/path after it is
  plain or dim-joined (`", "` between names is dimmed, not the names
  themselves).
- **Repeated similar calls collapse into one line.** A run of read-only exec
  calls doesn't produce N rows — it becomes one `Read a.ts, b.ts, c.ts` line.
  This is the single biggest de-cluttering trick in the whole design.
- **Command output**: dim text, first line prefixed with `"  └ "` (an
  L-connector tying it visually to the command above), continuation lines
  `"    "`. Truncated with a dim `"… +N lines"` ellipsis when it's long —
  head *and* tail are kept, not just the head.
- **Completion line**: `✓`/`✗` + exit code, then `" • {duration}"` in dim —
  status and timing share one line, not two.
- **Live/streaming state is just an animated version of the same bullet**
  (`activity_marker` swaps the static `"•".dim()` for an animated glyph via
  `activity_indicator`) — there is no separate spinner widget bolted on next
  to an icon. One glyph, two states (static vs. animated), not two glyphs.

### OpenCode (`packages/tui`, per source + DeepWiki)

- `InlineToolRow` / `ReasoningPart` pattern: tools default to a **compact
  inline row**; only expand into a full block when there's meaningful output.
- Reasoning uses `theme.warning` (not neutral gray) at reduced opacity, with a
  duration-labeled collapsed summary and a toggle — closer to what TierMux
  already does structurally, but the color says "this is the model's
  in-progress thought," not just "muted text."
- Completed, unremarkable tool calls **auto-hide** unless `showDetails()` is
  on — the transcript defaults to showing only what's currently relevant.
- Tool output collapses past a small line/char threshold (3–10 lines
  depending on tool) with a "click to expand" hint, rather than always
  rendering a scrollable box.
- Status glyphs are per-tool ($ bash, → read, ← write/edit, ✱ glob/grep, ⚙
  generic) but still just single characters, no icon set with strokes/fills.

### The shared principle, restated for a GUI (not a terminal)

Both tools spend almost no pixels on chrome. Status and category are carried
by **glyph + color + weight**, not by borders/backgrounds/badges. Grouping
and truncation do the decluttering that a "collapse into a details panel"
UI usually reaches for. TierMux is a webview, not a terminal, so we keep
rounded corners and a sidebar-appropriate type scale — but the card/pill
styling on tool rows and the reasoning block is heavier than either
reference, and that's the concrete gap to close.

## Where TierMux stands today (for contrast)

- `buildToolCard` (`media/src/ui/tool/ToolCard.ts:185`) renders every tool
  call as a bordered `.tm-tool-card` with its own header, chevron, and
  collapsible body — one full "card" per call, always, even for a single
  `readFile`.
- `buildReasoningBlock` (`ToolCard.ts:97`) renders a `.tm-reasoning` block
  with a header row (brain glyph + label + chevron) and a separate muted
  "content card" body — visually its own component, not inline transcript
  text.
- The collapsed run summary (`main.ts:1441`, `.work-summary`/`.work-sum-label`
  in `main.css`) was a pill/badge until this session's edit turned it into
  plain muted text — already one step in the Codex direction.
- No grouping: N consecutive `readFile` calls currently render as N separate
  tool cards.

## Checked against the actual AI SDK contract (not just visual taste)

TierMux streams turns through Vercel AI SDK v7 (`ai` in package.json) —
`engine.ts`'s `fullStream` loop switches on `text-delta`, `reasoning-delta`,
`tool-call`, `tool-error`, etc. Any visual redesign has to render a shape
that data actually produces, not one invented independently of it. Pulled
the canonical contract from the SDK's own component reference
(`elements.ai-sdk.dev/components/tool` and `/reasoning`, the design system
the existing `ToolCard.ts` comments already cite as inspiration) to check
where TierMux's simplified model lines up and where it doesn't.

**Tool parts have four states, TierMux's wire protocol has three.** The SDK
distinguishes `input-streaming` (arguments still being generated) from
`input-available` (arguments complete, now executing) — TierMux's
`ToolStep.state` (`toolStatus.ts:11`) only has `'running' | 'done' | 'error'`,
collapsing both into one `running`. That's fine today because nothing renders
partial tool-call arguments — but it means "show the edit's target path
while the model is still deciding the diff" isn't representable without a
new state. Not urgent, but worth knowing *before* someone tries to bolt a
live-args preview onto the current three-state enum and has to redesign the
wire message instead of extending it. If that ever comes up, add a fourth
`ToolStep.state` value rather than overloading `running` with a flag.

**AI Elements auto-opens `output-available` AND `output-error`; TierMux
auto-opens neither.** The reference `<Tool>` component expands successful
*and* failed calls by default — the assumption being a chat thread has few
enough tool calls that seeing each result is fine. TierMux's calls are
denser (a coding agent runs many small reads/edits per turn), so staying
collapsed-by-default for success is a **deliberate, correct divergence** —
that's the whole point of item 2 below, and it should stay that way rather
than "aligning" back to the reference default.

Errors are the one place worth reconsidering: today an errored tool call
(`toolLabel`'s error state, `ToolCard.ts:63`) shows a Retry button on a
collapsed card, so you have to click to see *why* it failed. Matching AI
Elements' auto-open-on-`output-error` here is low-risk (errors are rare
compared to reads) and is genuinely useful — see item 7.

**Reasoning's contract matches already.** `isStreaming` drives auto-open/close,
`duration` is `number | undefined` while streaming — `buildReasoningBlock` /
`updateReasoningBlock` already mirror this exactly (open while `isStreaming`,
settle to `Thought for Ns` once `durationMs` arrives). No gap here; the
flattening in item 4 is purely visual and doesn't touch this contract.

## Concrete change list

Ordered roughly by impact-to-effort ratio. **Items 1–4 and 7 are implemented**
(2026-09-03) — see the "Implementation notes" section below for what actually
landed, where it differs from the original plan, and one real bug the
implementation caught along the way.

1. ✅ **Group consecutive read-only tool calls into one line.** In whatever
   assembles `ToolStep[]` for a flow (see `toolStatus.ts` /
   `chatViewProvider.ts` upsert path), detect runs of `readFile`/`grep`/`glob`
   with no intervening edit/write and render them as a single row: bold verb
   (`Read`) + comma-joined dim-separated targets. This is the OpenCode/Codex
   trick that cuts the most visual noise and is independent of the styling
   work below.
2. ✅ **Flatten the tool-card chrome for the common case.** Keep the card
   affordance only for calls that actually have a body worth expanding
   (edits/diffs, long output, errors). For a plain successful `readFile` /
   `grep` / `ls`, render a single inline row: status glyph + bold verb + dim
   target + dim duration — no border, no background, no chevron. Reserve the
   full bordered card for `editFile`/`writeFile` diffs and failed calls,
   where the border earns its keep.
3. ✅ **Adopt a duration-on-the-status-line convention.** Wherever a tool
   settles, append `· {duration}` dim next to the status glyph (mirrors
   Codex's `✓ · 0.4s`) instead of only showing duration in the collapsed
   "Worked for Ns" summary. Gives per-step timing without new UI.
4. ✅ **Recolor reasoning as muted+italic body text, not a boxed card.** Drop
   `.tm-reasoning-content`'s card background/border for the *streaming*
   state; render the reasoning text inline, dim + italic, directly under the
   label line. Keep the collapse-after-done behavior (already implemented),
   but the *look* while open should read as "the model's undertone," per
   Codex, not a bordered secondary card competing with tool cards.
5. **Single glyph, two states, for "is this live."** Now that the pulsing
   dot is gone and the brain icon is static (this session), decide
   deliberately: either (a) leave it fully static and rely on the
   "Thinking…" → "Thought for Ns" label text alone to say "live" (current
   state), or (b) animate only the label's ellipsis (`Thinking.` → `..` →
   `...`) rather than reintroducing a second animated element. Don't add a
   second glyph back — Codex/OpenCode both key "live" off ONE element, never
   an icon plus a separate indicator.
6. **Tool status glyphs over icon set (optional, bigger change).** Consider
   replacing the per-tool icon set in `toolLabel()`/`ICON` with a smaller
   glyph vocabulary consistent with the point above — but this is a larger
   surface change (touches every tool's `toolLabel` mapping) and should be
   scoped separately once 1–4 are in and reviewed.
7. ✅ **Auto-expand failed tool calls — but keep it collapsible.** Matches AI
   Elements' `output-error` default (see the alignment check above): an
   errored card should open itself showing the failure text, with Retry
   alongside it, instead of staying collapsed behind a click. This changes
   only the *default* open state, not whether it's a disclosure — reuse the
   exact same toggle mechanism `buildToolCard` already has for every other
   card (`defaultOpen = state === 'error'` instead of always `false`), so a
   retried-and-fixed call can still be collapsed away like everything else.
   A card that opens on error but can never close again would recreate the
   exact clutter items 1–4 are removing. Success stays collapsed-by-default —
   that divergence from AI Elements is intentional, not a gap.

## Implementation notes (2026-09-03)

**Item 2 turned out to be much smaller than scoped.** By the time this was
implemented, `media/styles/components/tool-card.css` had already been
rewritten by other work on this branch to be flat-by-default (no card
background, a small status pill instead of a box) — the doc's original
"every tool call renders as a bordered card" description was stale. The
actual remaining gap was in `main.css`'s older, still-active
`.tool-card, .tm-tool-card` rule, which gave *every* card a `border-left: 2px solid` accent rail regardless of content (a leftover from a still-loaded,
older styling pass — two stylesheets both target `.tm-tool-card`, which is
its own small maintenance smell worth known about). Fixed by keying both the
rail (`main.css`) and the status pill's fill (`tool-card.css`) off `.has-body`
/`.error` — a signal already set correctly by both rendering paths — instead
of building new chrome-toggling logic from scratch.

**Item 1's grouping needed real state**, not just a rendering tweak, because
tool cards render through **two independent implementations** (flagged
earlier in this doc's history): `ToolCard.ts`'s `buildToolCard` for
static/replay, and a hand-rolled duplicate inside `main.ts`'s `upsertTool` for
live streaming. The static path groups in one pass over the full `steps`
array (see `main.ts`'s `pendingGroup`/`flushGroup` right before the render
loop). The live path is a per-Target `pendingReadGroup` pointer plus a
`toolMsgs` cache (`{name, args, state, durationMs}` per toolCallId) — every
update, live or grouped, **rebuilds the whole group fresh from that cache**
via `buildToolGroupRow` rather than hand-patching one item and recomputing an
aggregate status separately. That was a deliberate simplicity-over-
micro-optimization call: a group is a handful of DOM nodes, rebuilding it on
every settle is imperceptible, and it guarantees the live view can never
drift from what `buildToolGroupRow` (the same function the static/replay path
calls) would render for the same data — one renderer, one source of truth,
instead of two things that have to agree by construction.

A real bug surfaced while tracing this by hand before calling it done: the
first draft reset `pendingReadGroup` on *every* message for a call already in
flight (not just brand-new calls), which wiped `.el` back to `null` the
moment a lone pending read settled — so a *second* consecutive read arriving
right after would crash on `pendingReadGroup.el.replaceWith(...)`. Fixed by
scoping that reset to genuinely new toolCallIds only. No test caught this —
there's no DOM/webview test harness in this repo — it was caught by manually
tracing the running→done→next-call sequence step by step. **This piece (the
live grouping specifically) has not been exercised in an actual running
extension session**; everything else (types, esbuild, `test:e2e:foundation`,
`test:e2e:workReport`) passes, but those don't touch webview DOM code.

**No AI SDK conflicts.** None of items 1–4/7 touch request/response shapes —
grouping and chrome are purely a rendering-layer concern over data the wire
protocol already carries (`toolStatus`'s `durationMs`, added for item 3,
required backend changes — a new `toolStartTimes` map on `Session` in
`chatViewProvider.ts` and a `fmtToolDuration` formatter — but no SDK-facing
shape changed).

## Suggested next step

Try a real multi-file-read turn in a running extension to confirm the live
grouping renders and updates without error (see the caveat above) before
treating item 1 as fully done. After that: item 6 (the icon set) and the
`input-streaming`/`input-available` split noted in the alignment-check
section above remain unstarted.

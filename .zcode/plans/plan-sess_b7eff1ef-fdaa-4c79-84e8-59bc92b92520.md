# TierMux capability wave (v3.0.6) — STAGED, one green gate at a time

## Context

Gap analysis vs leading open-source agents (OpenCode, Claude Code, aider, Cline, Goose) found TierMux missing: **background processes**, **browser verification**, **symbol-aware repo map outside plan mode**, and **raw-PDF input**. This wave closes all four — but ships **stage by stage**: each stage must be green (new e2e + regressions) before the next starts. Version stays **3.0.6**. Browser backend = user's **system Chrome/Edge only**, zero new dependencies.

Reference files already read and in hand: `src/agent/core/tools/shell.ts` (detached spawn + `killTree`, the pattern to reuse) and `scripts/localServers.e2e.ts` (the e2e harness pattern: `check()` helper, section groups, `ALL PASS` + exit code, `test:e2e:*` package.json entry).

---

## STAGE 1 — Background shell tasks (the foundation; nothing else starts before this is green)

1. **New** `src/agent/core/tools/taskRegistry.ts` — `BackgroundTaskRegistry`:
   - Spawn reusing shell.ts's detached + `killTree` pattern, no timeout; per-task `{id: bg1.., command, child, startedAt, ring buffer ~64KB, lastOutputAt, lastReadAt, exitCode, status}`.
   - **Idle timeout:** 30 min with no new output AND no reads → killed, `idle-timeout` note. Exported constant (like runCommand's `DEFAULT_TIMEOUT_MS`); no setting yet.
   - **`touch(taskId?)`:** resets `lastReadAt` for one/all tasks — `browserVerify` will call `registry.touch()` around navigation so a quiet dev server is never idle-killed mid-verify.
   - **Cap 3:** refusal lists running task ids + commands.
   - **Approval:** background spawns go through the same toolApproval/dangerous-command path as `runCommand`; decision logged with the task id.
   - Lifecycle: explicit stop / session abort / extension dispose — never turn end.
2. **Modify** `src/agent/core/tools/v3/runCommand.ts` — `background?: boolean`; returns immediately with task id + taskOutput usage.
3. **New** `src/agent/core/tools/v3/taskOutput.ts` — `{taskId?, waitMs? (≤30s, default 5s), action?: 'read'|'stop'|'list'}`; missing taskId / `list` = list all tasks (id/command/status).
4. Register both in `tools/v3/index.ts` — **agent mode only**.
5. **`scripts/backgroundTasks.e2e.ts` FIRST-style:** start returns immediately; read; list-all; stop kills; cap refusal lists tasks; idle timeout frees a slot (injected clock); abort kills all; `touch()` resets the clock.
6. **Gate:** `npm run test:e2e:background-tasks` + **`npm run test:e2e:local-servers`** + `npm run typecheck` all green → CHANGELOG entry → only then Stage 2.

## STAGE 2 — fd spike, then browser verify

1. **Step 0 (blocking):** empirically verify Chrome's pipe fd mapping with the installed system Chrome (`stdio: ['ignore','pipe','pipe','pipe','pipe']`; expected write→fd3, read←fd4). If the mapping fails, re-derive §2 before writing the client.
2. **New** `src/agent/core/tools/network/cdp.ts` — `\0`-framed JSON, partial-read buffering; incrementing request id + pending-promise map; all pending rejected on process exit; temp `--user-data-dir` deleted in `finally` + on exit.
3. **New** `src/agent/core/tools/network/browserVerify.ts` — `browserVerify {url, waitMs?}`:
   - Discovery: `tiermux.chromePath` → platform Chrome → Edge → graceful "disabled" message.
   - **Hard 60s deadline** on the whole call (timeout verdict, never a hang).
   - **Subresource policy:** CDP `Fetch.enable` interception enforcing fetchUrl's URL/host policy (top-level already validated; allow same-origin + localhost subresources; block cross-origin private hosts — SSRF guard).
   - Pre-navigation listeners: `Runtime.exceptionThrown`, `Log.entryAdded`, console errors; HTTP status via `Network.responseReceived` (BROWSER_VERIFY_TOOL.md 4-layer design).
   - **Vision gating at call time** — checked inside `execute()` against the currently-routed model (routing can switch mid-session); screenshot only for vision-capable, saved to `.tiermux/shots/<ts>.png`; text-only models skip the capture entirely.
   - Calls `registry.touch()` before/after navigation.
   - Text summary primary: verdicts first, then first few errors; URLs stripped of query strings/tokens (summary + filenames).
   - System-prompt guidance in `src/context/system.ts` agent tail (+ negative guardrail); `fetchUrl` failure hint points here for JS-heavy pages. Agent mode only.
4. **`scripts/browserVerify.e2e.ts`** — local page with `console.error`; Chrome present → verdicts + errors + screenshot policy (vision mock captures, text mock skips, mid-session switch re-evaluates); Chrome absent → graceful-disable; never-loading → deadline path (fast-forwarded); subresource policy blocks cross-origin private host, allows localhost.
5. **Gate:** new suite + `typecheck` + re-run `local-servers`, `routing-gates` green → CHANGELOG → Stage 3.

## STAGE 3 — Repo map + raw PDF (independent, land together)

1. **`src/context/fileMap.ts`** — regex symbol extraction (function/class/method/interface signatures); `<project_files>` injected in agent+ask modes behind a setting (default on, off for small-window models); budget ~2–3% of routed model's window with floor/ceiling; **path+mtime cache**; **sorted by recently-touched files** so useful symbols survive truncation.
2. **`engine.ts:84-102`** — pass `application/pdf` file blocks through as AI SDK file parts, **gated on routed model capability** (`requireRawPdf` plumbing exists); non-capable → existing text extraction **with a visible which-path-was-used notice**; map file part in `openai-compat.ts` for accepting gateways; **remove the stale "v3.1 restores that flow" comment in the same change**.
3. **`scripts/fileMapSymbols.e2e.ts`** + **`scripts/pdfBlock.e2e.ts`** (pdf part reaches pdf-capable mock; text fallback + notice otherwise).
4. **Gate:** both suites + `opencode-lane`, `file-map`, `routing-gates`, `typecheck` green → CHANGELOG.

## STAGE 4 — Docs + release

- **New** `docs/OPEN_SOURCE_AGENTS_2026-11.md` — comparison (Claude Code / OpenCode / aider / Cline / Goose / Gemini CLI), TierMux has/lacks, how this wave closes gaps, system-Chrome-only rationale. **Every competitor claim re-verified against that project's current docs before publishing, with verification dates recorded.**
- Update `docs/BROWSER_VERIFY_TOOL.md` (→ implemented; CDP-over-pipe decision), `docs/FEATURES.md`; `package.json` → **3.0.6**.
- Final pass: full new-suite run + manual check (F5 → agent starts `npm run dev` in background → `browserVerify` localhost → fixes console error → re-verifies).

---

**Rule:** CHANGELOG updated at the END of each stage (not batched at the end). Any stage going red stops the line — no starting the next stage on a broken foundation.
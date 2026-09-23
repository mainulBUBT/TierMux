# The agent is Cline (2026-09-23)

TierMux does not build an agent. The coding agent — loop, tools, prompt, rules, skills,
compaction, MCP, plan/act modes — is [Cline](https://github.com/cline/cline)'s SDK. TierMux is
the model router and provider fleet underneath it and the UI on top of it.

Read this before touching `src/agent/core/cline/`, the tool cards in the webview, or the
approval policy. It replaces `SIMPLE_CORE_RESET_2026-08-24.md` and
`PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md`, which describe the TierMux-built harness this removed.

## Who owns what

| Cline (`@cline/agents`, `@cline/core`) | TierMux |
|---|---|
| The loop: iterations, tool execution, provider-error retries, the one overflow recovery, steering | **The model**: `routerModel.ts` serves every request from the picker's failover chain (keys, cooldowns, platform condemn) |
| Tools and their executors: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `editor`, `skills`, `ask_question` | **The approval decision**: `permissions/policy.ts` (the `commandApproval` / allowlist / write-confirmation settings and the Allow/Always/Reject UI) |
| Act/plan presets — plan mode has no editor | **The ask card**: Cline's `ask_question` executor calls the webview card |
| System prompt (`getClineDefaultSystemPrompt`, VS Code plan contract: the user flips to Act) | **The checkpoint baseline**: Cline's own editor executor, wrapped to record the pre-write content first |
| Rules and skills (`AGENTS.md`, `.clinerules/`, `.cline/skills`, `.agents/skills`) | **The UI**: tool cards, diffs, reasoning, changed-files bar — rendering Cline's tool names and shapes directly |
| Request compaction (deterministic "basic" strategy — no extra model call), incl. `/compact` | **Sessions**: the persisted transcript, re-seeded into Cline each turn |
| MCP connections and tool calls (`InMemoryMcpManager`, `createMcpTools`) | **MCP config**: `tiermux.mcpServers` and the MCP panel; tool names capped to the 64-char wire limit |
| The `<user_input mode>` / `<mode_notice>` message format | Wrapping each user turn in it (`withClineInput`) |

The rule that follows: **no agent behavior is written in TierMux.** A missing capability is
either Cline's (upgrade Cline, or report it upstream) or a routing/provider/UI concern. No
detectors, no nudges, no prompt towers, no second tool set.

## The seams (all in `src/agent/core/cline/`)

- `clineRuntime.ts` — loads the ESM-only `@cline/*` packages from the CJS bundle
  (`require` of the dist entry file; the specifier is built at runtime so esbuild does not
  inline the ESM graph).
- `clineEngine.ts` — one turn: `createBuiltinTools(ToolPresets[act|plan])` with three host
  executors (ask card, checkpoint-wrapped editor, skills), MCP tools in agent mode, Cline's
  prompt plus rules, `AgentRuntime` with the TierMux model, and events mapped onto the UI
  callbacks. Stop and Cline's step cap ("exceeded maxIterations") come back as a resumable
  pause; everything else Cline reports is passed through.
- `routerModel.ts` — the `AgentModel`. Also renames the opencode lane's decoy tools
  (`read`, `bash`) to `read_files` / `run_commands`.
- `prepareTurn.ts` — adapts the runtime's `prepareTurn` context to Cline's compaction
  pipeline, and runs it once in manual mode for `/compact`.

`src/agent/toolArgs.ts` (provider side) rescues tool calls weak models write as text and
maps imagined names and flat arguments onto Cline's tools (`{path}` → `files: [{path}]`).

## Why the router is an AgentModel, not a Cline provider

Cline's llms layer accepts a custom provider (`Llms.registerHandler`, `createLlmsSdk`
`customProviders`), but the gateway behind a `providerId` rejects any id outside its built-in
catalog ("Unknown or disabled provider"), verified against 0.0.85. So TierMux passes a built
model (`AgentRuntimeConfigWithModel`). Two consequences:

- Everything Cline builds from a `providerId` is out of reach: `ClineCore` /
  `LocalRuntimeHost` session orchestration, git checkpoints, and **sub-agents / teams**
  (`spawn_agent` builds each sub-agent through `SessionRuntime`). TierMux offers none of these.
- The way to get all of it is to serve the router as a local OpenAI-compatible endpoint and
  register it as an ordinary Cline provider. Not built yet.

## Upgrading Cline

The four `@cline/*` packages are pinned to one exact version (0.0.x moves fast).

1. Bump all four together in `package.json`, `npm install`.
2. `npx tsc -p tsconfig.json --noEmit` — the seams are typed against the packages' own
   `.d.ts`, so API drift shows up here.
3. `npm run test:e2e:foundation` (THE contract), `test:e2e:cline-engine`, then the rest of
   `test:e2e:*`.
4. If Cline renamed or reshaped a tool, update `READ_ONLY_TOOLS` / `MUTATING_FILE_TOOLS` in
   `permissions/policy.ts`, the tool cards in `media/src/ui/tool/ToolCard.ts`, and the
   aliases in `toolArgs.ts` / `routerModel.ts`.
5. Re-check the gateway wall above — if Cline starts accepting custom provider ids, the
   router can move behind a `providerId` and `ClineCore` becomes usable.

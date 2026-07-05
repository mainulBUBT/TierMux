// Builds the OpenCode config that points OC at the TierMux router proxy.
// Injected via the OPENCODE_CONFIG_CONTENT env var (OC's flag.ts), so no temp
// file is written and the user's global ~/.config/opencode is untouched.
//
// OC sees one custom OpenAI-compatible provider, "tiermux", with three virtual
// models (auto/fast/smart) backed by the router proxy. Failover, rate-limit
// cooldowns, and cost tracking all happen inside the proxy/router — OC just
// thinks it has one reliable provider.
import type { McpServerConfig } from '../mcp/mcpClient';

export interface OcConfigOptions {
  /** Router proxy base URL, e.g. http://127.0.0.1:4321/v1 */
  routerProxyBaseURL: string;
  /** Shared secret OC sends as the API key (and that the proxy may validate later). */
  apiKey?: string;
  /** Default agent when none is specified. TierMux uses "build". */
  defaultAgent?: string;
  /** Absolute paths to instruction files appended to every agent's system prompt
   *  (used to rebrand the assistant as TierMux and keep it task-focused). */
  instructionsPaths?: string[];
  /**
   * `tm_<base64url>` encoded IDs of all currently enabled catalog and custom-endpoint
   * models. Added to the static `models` block so OC validates them at session creation.
   * Generated at launch time from settings.enabledByPriority(); models added later
   * require a reload to pick up.
   */
  extraModelIds?: string[];
  /** `tiermux.mcpServers` setting, keyed by server name — mapped onto OC's native
   *  `mcp` config block so OC discovers and calls their tools itself. */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Returns a JSON string OC parses as its config. See OC's ProviderConfig schema
 * (config/provider.ts): `npm` selects the SDK adapter, `options.baseURL`/`apiKey`
 * target the proxy, and `models` declares the virtual routing profiles.
 */
export function buildOcConfig(opts: OcConfigOptions): string {
  // Kilo-Code-style grounding preamble prepended to every agent prompt. The absolute rule:
  // never answer about this codebase from training-data memory — always read first. Stated
  // forcefully because free-tier models hallucinate the instant they skip tool calls.
  const GROUNDED =
    'You are TierMux, an AI coding assistant working inside the user\'s project. '
    + 'The project on disk is your SOURCE OF TRUTH, not your training data.\n'
    + 'GROUNDING RULES (non-negotiable):\n'
    + '1. NEVER describe, summarize, or reason about this project\'s files, code, structure, '
    + 'types, configs, dependencies, or behavior from memory. ALWAYS read the relevant files '
    + 'first with read/list/glob/grep, then ground your answer in what you actually read.\n'
    + '2. If you are UNSURE where something lives, search (glob/grep) before answering — do not guess.\n'
    + '3. NEVER invent file names, symbol names, function signatures, or behavior you did not read. '
    + 'If you cannot find it, say so or ask.\n'
    + '4. Cite the file path (and line) you used for each non-trivial claim.\n\n';

  // Virtual routing profiles — always present so OC's default model (tiermux/auto)
  // is valid and the three "speeds" the UI exposes map to the router's task-kind logic.
  const models: Record<string, object> = {
    auto:  { name: 'Auto',  limit: { context: 128000, output: 8192 } },
    fast:  { name: 'Fast',  limit: { context: 128000, output: 8192 }, attachment: false },
    smart: { name: 'Smart', limit: { context: 200000, output: 8192 } },
  };

  // Every enabled catalog / custom-endpoint model encoded as tm_<base64url> so
  // OC recognises it at createSession + prompt without choking on '::' or '/'.
  for (const id of opts.extraModelIds ?? []) {
    models[id] = { name: id, limit: { context: 128000, output: 8192 } };
  }

  // `tiermux.mcpServers` entries already match OC's native McpLocalConfig/McpRemoteConfig
  // shape field-for-field (see mcpClient.ts), so this is a near-direct passthrough — just
  // dropping explicitly-disabled entries. Once present in OC's own config, OC discovers
  // and calls these tools itself.
  const mcp: Record<string, object> = {};
  for (const [name, sc] of Object.entries(opts.mcpServers ?? {})) {
    if (sc.enabled === false) continue;
    mcp[name] = sc.type === 'local'
      ? {
          type: 'local',
          command: sc.command,
          ...(sc.environment ? { environment: sc.environment } : {}),
          ...(sc.cwd ? { cwd: sc.cwd } : {}),
          ...(sc.timeout ? { timeout: sc.timeout } : {}),
          enabled: true,
        }
      : {
          type: 'remote',
          url: sc.url,
          ...(sc.headers ? { headers: sc.headers } : {}),
          ...(sc.oauth !== undefined ? { oauth: sc.oauth } : {}),
          ...(sc.timeout ? { timeout: sc.timeout } : {}),
          enabled: true,
        };
  }

  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      tiermux: {
        npm: '@ai-sdk/openai-compatible',
        name: 'TierMux',
        options: {
          baseURL: opts.routerProxyBaseURL,
          apiKey: opts.apiKey ?? 'local',
        },
        models,
      },
    },
    // Force every agent in OC to use the TierMux provider by default, so model
    // selection always flows through the router. Users can still override per-session.
    model: 'tiermux/auto',
    // Custom agents. OC's built-in `build` edits and `plan` writes a plan file then
    // exits — neither fits Chat mode, which needs a read-only Q&A answerer. So we
    // register our own `chat` agent: it may inspect the project (read/list/glob/grep)
    // and fetch current info (web_fetch/web_search), but CANNOT edit/write/move/remove
    // files or run commands/bash/subagents. Tool names match OC's wire names (note the
    // underscores on the web tools). `permission` is the modern per-tool allow/deny map;
    // `tools: {bool}` also works but is deprecated. OC reads this ONLY at startup, so a
    // running OC process won't see a new agent until it restarts (a window reload does it).
    agent: {
      // Kilo-Code-style grounding preamble shared by every agent. The #1 rule: NEVER answer
      // about the codebase from training-data memory — always read first. Free-tier models
      // hallucinate the moment they skip tool calls, so this is stated as an absolute.
      // `GROUNDED` is prepended to each agent's mode-specific prompt below.
      // (chat/planx are read-only; build may edit. Permissions differ per agent.)
      chat: {
        mode: 'primary',
        description: 'Read-only Q&A: reads the project and the web, cannot modify files or run commands.',
        prompt: GROUNDED
          + 'You are the ASK assistant. Answer the user\'s question accurately.\n'
          + '- ANY question about this project (files, architecture, how something works, types, '
          + 'configs, dependencies, behavior) → READ the relevant files FIRST with read/list/glob/grep, '
          + 'then answer grounded in what you actually found. Quote file paths.\n'
          + '- ONLY for questions with no connection to this codebase (general programming concepts, '
          + 'language syntax, theory) may you answer from knowledge — and even then, say so.\n'
          + '- If you cannot find the answer in the project after searching, say you couldn\'t find it. '
          + 'Do NOT guess or invent file names, symbols, or behavior.\n'
          + 'You CANNOT edit/write/move/remove files, run commands, or spawn subagents. '
          + 'Use web_fetch/web_search only for current information you cannot find locally. '
          + 'Cite file paths and URLs.',
        permission: {
          read: 'allow', list: 'allow', glob: 'allow', grep: 'allow',
          web_fetch: 'allow', web_search: 'allow',
          write: 'deny', edit: 'deny', bash: 'deny',
          move: 'deny', remove: 'deny', task: 'deny', todowrite: 'deny', code_execution: 'deny',
        },
      },
      // Agent mode. Overrides OC's built-in `build` so TierMux controls the prompt — the
      // built-in's generic prompt lets free-tier models edit blindly from memory.
      build: {
        mode: 'primary',
        description: 'Full agent: reads the project, then edits files and runs commands.',
        prompt: GROUNDED
          + 'You are the AGENT. You CAN edit/write/move/remove files and run commands (bash).\n'
          + '- BEFORE any edit: read the file and its callers/dependents with read/grep/glob so the '
          + 'change fits the real project. Never edit a file you have not read in this session.\n'
          + '- Make the smallest correct change. Re-use existing patterns and helpers.\n'
          + '- After editing: verify (grep for other call sites, run typecheck/tests) when feasible.\n'
          + '- If the task is ambiguous or you cannot find the relevant code, ask the user (use the '
          + 'clarifying-questions block) instead of guessing.\n'
          + 'Cite file paths and URLs you used.',
        permission: {
          read: 'allow', list: 'allow', glob: 'allow', grep: 'allow',
          web_fetch: 'allow', web_search: 'allow',
          write: 'allow', edit: 'allow', bash: 'allow',
        },
      },
      // Plan mode. OC's BUILT-IN `plan` writes to .opencode/plans/*.md then `plan_exit`s into
      // `build` — file/handoff-oriented, never returns the plan as text, so TierMux's
      // planProposed card gets garbage. This custom `planx` is a read-only researcher that
      // returns the plan INLINE as text. Named `planx` to avoid colliding with the built-in.
      planx: {
        mode: 'primary',
        description: 'Read-only planner: reads the project and returns a step-by-step plan as text.',
        prompt: GROUNDED
          + 'You are the PLANNER. Research the request with read/list/glob/grep (and web_fetch/web_search '
          + 'when needed) BEFORE planning — every step must reference real files/symbols you verified.\n'
          + 'Reply with a concise, actionable plan as TEXT: numbered steps, each naming the file/symbol '
          + 'it touches and what to do. Do NOT edit/write/move/remove files and do NOT run commands — '
          + 'planning only.\n'
          + 'If the request is ambiguous, or you cannot find the relevant code, FIRST emit a '
          + 'clarifying-questions block in EXACTLY this format and then stop (no plan yet):\n'
          + '???QUESTIONS???\n'
          + 'Q[Short Label]: the question?\n'
          + '- Option A :: optional one-line description\n'
          + '- Option B :: optional one-line description\n'
          + '???END???\n'
          + 'Otherwise skip the block and output only the plan. Keep it tight and skimmable.',
        permission: {
          read: 'allow', list: 'allow', glob: 'allow', grep: 'allow',
          web_fetch: 'allow', web_search: 'allow',
          write: 'deny', edit: 'deny', bash: 'deny',
          move: 'deny', remove: 'deny', task: 'deny', todowrite: 'deny', code_execution: 'deny',
        },
      },
    },
    // Append our identity/behavior instructions to every agent's system prompt so the
    // assistant presents as TierMux (not "opencode") and acts on the task directly.
    ...(opts.instructionsPaths?.length ? { instructions: opts.instructionsPaths } : {}),
    ...(Object.keys(mcp).length ? { mcp } : {}),
  };
  return JSON.stringify(cfg);
}

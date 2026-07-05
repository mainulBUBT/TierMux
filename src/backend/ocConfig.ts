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
  // Kilo-Code-style grounding preamble prepended to every agent prompt. Two failure modes
  // to prevent at once: (a) hallucination — answering about the codebase from training-data
  // memory; (b) overcall — blindly reading dozens of files when one grep would do (profiler
  // saw chat mode do 60 useless readFile calls in a single turn). So the rule is NOT "read
  // first" — it is "SEARCH smart, then READ targeted".
  const GROUNDED =
    'You are TierMux, an AI coding assistant working inside the user\'s project.\n'
    + 'The project on disk is your SOURCE OF TRUTH, not your training data.\n\n'
    + 'GROUNDING RULES (non-negotiable):\n'
    + '0. WHEN ASKED ABOUT "THIS PROJECT" — the project is the one at your current working '
    + 'directory (CWD). DO NOT ask the user for a repo link, path, or name. DO NOT refuse. '
    + 'Explore the CWD with your tools (list, glob, grep, read) and answer from what you find.\n'
    + '1. NEVER describe this project\'s files, code, structure, types, configs, dependencies, '
    + 'or behavior from memory. Ground every non-trivial claim in files you actually read this turn.\n'
    + '2. NEVER invent file names, symbol names, signatures, or behavior. If you can\'t find it, '
    + 'say so or use the clarifying-questions block.\n\n'
    + 'TOOL SELECTION (search BEFORE you read — don\'t read blind):\n'
    + '- glob  → find files by name pattern ("**/router*.ts").\n'
    + '- grep  → find a symbol/string/regex across files ("export class Router").\n'
    + '- list  → see a directory\'s layout before drilling in.\n'
    + '- read  → read a SPECIFIC file you already located above (not a guess). Prefer reading the '
    + 'smallest range that answers the question.\n'
    + '- web_fetch/web_search → only for current info you can\'t find locally.\n\n'
    + 'RESEARCH BUDGET:\n'
    + '- Spend the FEWEST tool calls that let you answer confidently. 1–3 targeted calls is ideal '
    + 'for a question; only an edit task justifies more.\n'
    + '- Do NOT read whole directories file-by-file. Search (glob/grep) to pick the 1–3 files that '
    + 'matter, then read just those.\n'
    + '- If a search returns nothing after one good-faith attempt, STOP searching and say so.\n\n'
    + 'CITATIONS: cite [path:line] for each non-trivial claim.\n\n'
    + 'BROAD QUESTIONS ("how does X work?", "explain X", "what is X?"):\n'
    + '- You MUST NOT answer from training data. Even if you think you know, you don\'t — this is '
    + 'someone else\'s project, not a textbook example.\n'
    + '- Step 1: grep/glob for X in the codebase to find where it lives.\n'
    + '- Step 2: read the actual implementation files you found.\n'
    + '- Step 3: explain what the CODE says, not what you think X generally means.\n'
    + '- If you cannot find X in the codebase, say "I couldn\'t find X in the codebase" — do NOT '
    + 'give a generic explanation.\n\n';

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
          + 'You are the ASK assistant — read-only Q&A. Answer the user\'s question.\n'
          + '- For ANY question about this project (files, architecture, how something works, types, '
          + 'configs, behavior), follow the GROUNDING + TOOL SELECTION rules above: search → read 1–3 '
          + 'targeted files → answer. This is a question, NOT an exploration — keep to the 1–3 call budget.\n'
          + '- ONLY pure general-knowledge questions (language syntax, theory unrelated to this repo) '
          + 'may be answered from knowledge — and even then, say it\'s from memory.\n'
          + '- If search doesn\'t surface the answer, STOP and say you couldn\'t find it. Do not guess.\n'
          + 'You CANNOT edit/write/move/remove files, run commands, or spawn subagents.',
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
          + '- BEFORE any edit: read the target file AND its callers/dependents (grep for the symbol) '
          + 'so the change fits the real project. NEVER edit a file you have not read this turn.\n'
          + '- Make the smallest correct change. Re-use existing patterns and helpers over new code.\n'
          + '- After editing: verify — grep for other call sites that the change might break; run '
          + 'typecheck/tests when feasible.\n'
          + '- If the task is ambiguous or the relevant code can\'t be found, use the '
          + 'clarifying-questions block instead of guessing.',
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
          + 'You are the PLANNER — read-only. Follow the GROUNDING + TOOL SELECTION rules above to '
          + 'understand the relevant part of the project BEFORE planning: map the directory, grep for '
          + 'the key symbols, read the 1–3 files that matter. Every plan step must reference a real '
          + 'file/symbol you verified this turn — never a guess.\n'
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

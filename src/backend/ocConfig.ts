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
      chat: {
        mode: 'primary',
        description: 'Read-only Q&A: searches the project and the web, cannot modify files or run commands.',
        prompt: 'Answer the user. Use read/list/glob/grep to inspect the project and web_fetch/web_search for '
          + 'current information. You CANNOT edit, write, move, or remove files, and cannot run commands or '
          + 'subagents — if an action is required, say so and suggest the user switch to Agent mode. '
          + 'Cite file paths and URLs.',
        permission: {
          read: 'allow', list: 'allow', glob: 'allow', grep: 'allow',
          web_fetch: 'allow', web_search: 'allow',
          write: 'deny', edit: 'deny', bash: 'deny',
          move: 'deny', remove: 'deny', task: 'deny', todowrite: 'deny', code_execution: 'deny',
        },
      },
      // Plan mode. OC's BUILT-IN `plan` agent writes its output to .opencode/plans/*.md and then
      // `plan_exit`s into `build` — that's file/handoff-oriented, so it never returns the plan as a
      // text answer and TierMux's planProposed card gets garbage. This custom `planx` agent is a
      // read-only researcher that returns the plan INLINE as text (which chatViewProvider turns into
      // the approval card). Named `planx` (not `plan`) so it doesn't collide with the built-in.
      planx: {
        mode: 'primary',
        description: 'Read-only planner: researches the project and returns a step-by-step plan as text.',
        prompt: 'You are TierMux\'s planner. Research the request with read/list/glob/grep (and '
          + 'web_fetch/web_search when needed), then reply with a concise, actionable plan as TEXT: '
          + 'numbered steps, each naming the file/symbol it touches and what to do. Do NOT edit, write, '
          + 'move, or remove files, and do NOT run commands — planning only.\n'
          + 'If the request is ambiguous, FIRST emit a clarifying-questions block in EXACTLY this format '
          + 'and then stop (no plan yet):\n'
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

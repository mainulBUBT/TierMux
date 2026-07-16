

import type { McpServerConfig } from '../mcp/mcpClient';

export interface OcConfigOptions {
  /** Router proxy base URL, e.g. http://127.0.0.1:4321/v1 */
  routerProxyBaseURL: string;
  /** Shared secret OC sends as the API key (and that the proxy may validate later). */
  apiKey?: string;
  /** Default agent when none is specified. TierMux uses "build". */
  defaultAgent?: string;
  /** Absolute paths to instruction files appended to every agent's system prompt
   *  (used to carry dynamic per-workspace context: project rules, user memory, the
   *  installed-skills index). Appended AFTER the base prompt by OC. */
  instructionsPaths?: string[];
  /**
   * Core TierMux agent scaffolding (identity + behavior + ask-format + research, loaded
   * from `.tiermux/agent/*.md`). Set as the `prompt` on OC's native `build`/`plan` agents,
   * which REPLACES OC's ~9 KB "You are opencode…" default preamble. Without this, that
   * generic preamble leads the system prompt and buries the TierMux instructions at the
   * tail — free models then ignore the grounding/behavior rules and burn tokens on a much
   * larger prompt. Verified live against OC 1.17.14: agent.prompt set → 2 KB TierMux-first
   * system prompt; unset → 10.5 KB opencode-first prompt. Keep this set.
   */
  agentPrompt?: string;
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
  /**
   * `tiermux.engine.compaction` setting (camelCase), mapped onto OC's top-level
   * `compaction` block (snake_case). When undefined, OC's built-in defaults
   * (`{ auto: true, tail_turns: 15 }`) apply. Setting `auto: true` makes OC compact
   * server-side BEFORE a provider context-length error can surface — see Fix 1.
   */
  compaction?: { auto: boolean; tailTurns: number; preserveRecentTokens: number; reserved: number };
}

/**
 * Short mode-specific tails appended to the shared `.tiermux/agent` scaffolding to give
 * OC's native `build`/`plan` agents distinct prompts. Kept minimal on purpose — the bulk of
 * behavior lives in the editable `.tiermux/agent/*.md` files; these only encode the one thing
 * those shared files can't: what THIS mode is and how it should treat a trivial message.
 */
const BUILD_MODE_TAIL =
  '\n\n## Agent mode\n'
  + 'You can edit/write files and run commands. First check what the message actually asks: '
  + 'if it is only a question or a greeting, answer in text — do NOT edit files just because '
  + 'you can. Only modify files when the user asks you to change, fix, add, remove, or '
  + 'implement something.';

const PLAN_MODE_TAIL =
  '\n\n## Plan mode\n'
  + 'You are in READ-ONLY plan mode: you cannot edit files or run commands. For a real task '
  + 'or change request, investigate the relevant files first, then reply with a concise, '
  + 'numbered, step-by-step plan as TEXT — each step naming the file/symbol it touches. '
  + 'For a trivial message (a greeting like "hi", small talk, or a simple question), just '
  + 'reply briefly and directly — do NOT fabricate a plan for it.';

/**
 * Returns a JSON string OC parses as its config. See OC's ProviderConfig schema
 * (config/provider.ts): `npm` selects the SDK adapter, `options.baseURL`/`apiKey`
 * target the proxy, and `models` declares the virtual routing profiles.
 */
export function buildOcConfig(opts: OcConfigOptions): string {

  const models: Record<string, object> = {
    auto:  { name: 'Auto',  limit: { context: 128000, output: 8192 } },
    fast:  { name: 'Fast',  limit: { context: 128000, output: 8192 } },
    smart: { name: 'Smart', limit: { context: 200000, output: 8192 } },
  };

  for (const id of opts.extraModelIds ?? []) {
    models[id] = { name: id, limit: { context: 128000, output: 8192 } };
  }

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

    model: 'tiermux/auto',

    // Override the `prompt` on OC's built-in `build`/`plan` agents so the TierMux scaffolding
    // LEADS the system prompt and replaces OC's generic "You are opencode…" preamble. Only
    // `prompt` (and `mode`) is set — tools and permissions are intentionally left to OC's
    // native build (full) / plan (read-only) defaults, per the OC-native-permissions design.
    // Each agent gets a short mode-specific tail on top of the shared scaffolding: without a
    // plan-specific tail, plan == build and behavior.md's "never reply with a greeting — get
    // to work" makes read-only plan mode fabricate a plan even for "hi". The tails restore the
    // planner/executor distinction and carve out trivial greetings.
    ...(opts.agentPrompt
      ? {
          agent: {
            build: { mode: 'primary', prompt: opts.agentPrompt + BUILD_MODE_TAIL },
            plan: { mode: 'primary', prompt: opts.agentPrompt + PLAN_MODE_TAIL },
          },
        }
      : {}),

    ...(opts.instructionsPaths?.length ? { instructions: opts.instructionsPaths } : {}),
    ...(Object.keys(mcp).length ? { mcp } : {}),

    // OC-native auto-compaction (Fix 1): lets OC summarize older turns server-side
    // before a provider context-length error ever surfaces. camelCase setting → OC's
    // snake_case keys. When opts.compaction is undefined we omit the block and OC's
    // built-in defaults ({ auto: true, tail_turns: 15 }) apply.
    ...(opts.compaction ? {
      compaction: {
        auto: opts.compaction.auto,
        prune: true,
        tail_turns: opts.compaction.tailTurns,
        preserve_recent_tokens: opts.compaction.preserveRecentTokens,
        reserved: opts.compaction.reserved,
      },
    } : {}),
  };
  return JSON.stringify(cfg);
}

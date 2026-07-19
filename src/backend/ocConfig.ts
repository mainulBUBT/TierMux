

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
  + 'or change request, investigate the relevant files first, then reply with a concise plan '
  + 'as TEXT, using numbered or bulleted steps — each step naming the file/symbol it touches. '
  + 'If the work naturally splits into different priority/effort tiers (e.g. quick wins vs '
  + 'larger changes), group steps under short headings for that instead of one flat list — '
  + 'but keep the actual steps under each heading as a numbered/bulleted list, not prose, so '
  + 'they can still be reviewed and approved individually. '
  + 'For a trivial message (a greeting like "hi", small talk, or a simple question), just '
  + 'reply briefly and directly — do NOT fabricate a plan for it. '
  + 'If you need to ask the user something before you can plan, use ONLY the '
  + '???QUESTIONS???...???END??? text block (see the ask-format instructions) — do NOT call '
  + 'an interactive question/ask tool for this. That block is the single clarifying-question '
  + 'channel for plan mode; calling a tool on top of it asks the same thing twice through two '
  + 'different UI cards, which is confusing. Once the user has answered a ???QUESTIONS??? '
  + 'round, treat that as final — proceed to produce the plan using their answers and your own '
  + 'best judgment for anything still unspecified, rather than asking again.';

const ASK_MODE_TAIL =
  '\n\n## Ask mode\n'
  + 'You are in READ-ONLY Ask mode: you cannot edit files or run commands. Answer the '
  + "user's question directly. If it's about this project, read/search the files to ground "
  + 'your answer. If it is a general-knowledge or current-events question unrelated to the '
  + 'project (news, sports scores, weather, prices, anything time-sensitive), use the '
  + 'webfetch/websearch tools to look it up and answer directly — you DO have live web access '
  + 'through those tools, so never claim you lack real-time information without first trying '
  + 'them. Do not propose a plan or list steps to execute; just answer.';

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
    // LEADS the system prompt and replaces OC's generic "You are opencode…" preamble. `build`
    // keeps OC's native full-tool defaults untouched, per the OC-native-permissions design.
    // Each agent gets a short mode-specific tail on top of the shared scaffolding: without a
    // plan-specific tail, plan == build and behavior.md's "never reply with a greeting — get
    // to work" makes read-only plan mode fabricate a plan even for "hi". The tails restore the
    // planner/executor distinction and carve out trivial greetings.
    ...(opts.agentPrompt
      ? {
          agent: {
            build: { mode: 'primary', prompt: opts.agentPrompt + BUILD_MODE_TAIL },
            // Plan mode already has its OWN clarifying-question channel (the
            // ???QUESTIONS???...???END??? text sentinel, parsed by parseClarifying and
            // rendered as the `clarifyingQuestions` card). OC's native `question` tool is
            // otherwise wired unconditionally for every mode (agentCallbacks isn't mode-gated
            // — see chatViewProvider.ts), so a model can in principle ask via the sentinel AND
            // via the tool for the same plan, producing two near-identical interactive cards.
            // PLAN_MODE_TAIL prompts against this. Tried also hard-disabling the tool via
            // `tools: { question: false }` (OC's per-agent tool-enable map) — reverted: it does
            // NOT remove `question` from what's offered to the model, it just rejects the call
            // at execution time with an "unavailable tool" error (confirmed via the
            // pre-existing TOOL_CALL_ERROR regex in sdk.ts, added before this change to handle
            // exactly that OC error class). A model that still tries calling it now gets a hard
            // error + retry instead of a redundant card — worse than the bug being fixed. Prompt
            // enforcement only, until a real tool-removal mechanism is confirmed.
            plan: { mode: 'primary', prompt: opts.agentPrompt + PLAN_MODE_TAIL },
            ask: {
              mode: 'primary',
              prompt: opts.agentPrompt + ASK_MODE_TAIL,
              permission: { edit: 'deny', bash: 'deny' },
            },
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

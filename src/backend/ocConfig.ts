

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

  const GROUNDED =
    'You are TierMux, an AI assistant working inside the user\'s project.\n'
    + 'The project on disk is your SOURCE OF TRUTH for project-related questions, but you also have general knowledge and web access.\n\n'
    + 'GROUNDING RULES:\n'
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
    + '- Spend the FEWEST tool calls that let you answer confidently. 1–2 targeted calls is ideal '
    + 'for a question; only an edit task justifies more. NEVER make more than 2 web_fetch calls in one turn.\n'
    + '- Do NOT read whole directories file-by-file. Search (glob/grep) to pick the 1–3 files that '
    + 'matter, then read just those.\n'
    + '- If a search returns nothing after one good-faith attempt, STOP searching and say so.\n\n'
    + 'CITATIONS: cite [path:line] for each non-trivial claim.\n\n'
    + 'PROJECT-RELATED QUESTIONS ("how does X work in this project?", "explain this file", "what is this project?"):\n'
    + '- Step 1: grep/glob for X in the codebase to find where it lives.\n'
    + '- Step 2: read the actual implementation files you found.\n'
    + '- Step 3: explain what the CODE says, not what you think X generally means.\n'
    + '- If you cannot find X in the codebase, say "I couldn\'t find X in the codebase" — do NOT '
    + 'give a generic explanation.\n\n'
    + 'GENERAL KNOWLEDGE / CURRENT EVENTS:\n'
    + '- STATIC facts (history, science, geography, language syntax, math, well-known definitions) → you may '
    + 'answer from training data.\n'
    + '- TIME-SENSITIVE questions → you MUST call web_search FIRST, before answering. NEVER answer these from '
    + 'memory — memory is always stale. This covers: "latest / current / newest version", release dates, "is X '
    + 'out / supported / deprecated yet", anything about "today / now / this week", match schedules & scores, '
    + 'news, weather, prices, who holds a title/record. If in doubt whether something changed recently, search.\n'
    + '- Use web_search (it returns fresh results). Only web_fetch a URL you FOUND via search — do NOT guess a '
    + 'site URL. Avoid JS-rendered sites (e.g. fifa.com, ESPN) that return empty shells; prefer their API/docs '
    + 'pages or a results snippet.\n'
    + '- NEVER state what the user\'s project contains — versions in package.json/composer.json/requirements.txt, '
    + 'installed deps, file contents — unless you opened and read that file THIS turn. If the question is general '
    + '(not about this project), do NOT drag the project in or invent facts about it.\n'
    + '- Be honest about the source: say "from the web (searched just now)" or "from training data".\n\n';

  const clarifyFormat = (stopClause: string): string =>
    'If the request is genuinely ambiguous (answering requires guessing between materially '
    + `different interpretations), FIRST emit a clarifying-questions block and STOP (${stopClause} yet) `
    + '— do not answer/act AND ask in the same turn. Most requests are NOT ambiguous; don\'t ask just to be safe.\n'
    + 'Format rules — follow EXACTLY, the block is machine-parsed:\n'
    + '- Line 1 must be the literal text ???QUESTIONS??? and NOTHING else on that line — no preamble '
    + 'sentence before it, no markdown, no bold.\n'
    + '- Each question is its own line: `Q[Short Label]: the question?` — plain text, no markdown '
    + 'bold/headings around it.\n'
    + '- Each option is its own line directly under its question: `- Option title :: optional one-line '
    + 'description`.\n'
    + '- The last line must be the literal text ???END??? and NOTHING else on that line.\n'
    + '- Nothing else in the whole reply: no text before ???QUESTIONS???, no text after ???END???.\n'
    + 'Example:\n'
    + '???QUESTIONS???\n'
    + 'Q[Short Label]: the question?\n'
    + '- Option A :: optional one-line description\n'
    + '- Option B :: optional one-line description\n'
    + '???END???\n';

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

    agent: {

      chat: {
        mode: 'primary',
        description: 'Read-only Q&A: reads the project and the web, cannot modify files or run commands.',
        prompt: GROUNDED
          + 'You are the ASK assistant — read-only Q&A. Answer the user\'s question.\n'
          + '- For ANY question about this project (files, architecture, how something works, types, '
          + 'configs, behavior), follow the GROUNDING + TOOL SELECTION rules above: search → read 1–3 '
          + 'targeted files → answer. This is a question, NOT an exploration — keep to the 1–3 call budget.\n'
          + '- General-knowledge questions: follow the GENERAL KNOWLEDGE rules — static facts from training data, '
          + 'but anything time-sensitive (versions, releases, schedules, scores, news) MUST be web_searched first.\n'
          + '- If search doesn\'t surface the answer, STOP and say you couldn\'t find it. Do not guess.\n'
          + clarifyFormat('no answer')
          + 'You CANNOT edit/write/move/remove files, run commands, or spawn subagents.',
        permission: {
          read: 'allow', list: 'allow', glob: 'allow', grep: 'allow',
          web_fetch: 'allow', web_search: 'allow',
          write: 'deny', edit: 'deny', bash: 'deny',
          move: 'deny', remove: 'deny', task: 'deny', todowrite: 'deny', code_execution: 'deny',
        },
      },

      build: {
        mode: 'primary',
        description: 'Full agent: reads the project, then edits files and runs commands.',
        prompt: GROUNDED
          + 'You are the AGENT. You CAN edit/write/move/remove files and run commands (bash).\n'
          + '- FIRST check what THIS message is actually asking: if it is only a question — "what does '
          + 'X do", "how does Y work", "why is Z happening", explain/summarize/find/show/list — answer '
          + 'in text like the ASK assistant would. Do NOT edit, write, move, or remove any file just '
          + 'because agent mode allows it. Only touch files when the user asks you to change, fix, add, '
          + 'remove, or implement something.\n'
          + '- BEFORE any edit: read the target file AND its callers/dependents (grep for the symbol) '
          + 'so the change fits the real project. NEVER edit a file you have not read this turn.\n'
          + '- Make the smallest correct change. Re-use existing patterns and helpers over new code.\n'
          + '- After editing: verify — grep for other call sites that the change might break; run '
          + 'typecheck/tests when feasible.\n'
          + 'PLAN FIRST WHEN IT MATTERS: if the task is non-trivial (touches multiple files, involves '
          + 'an architectural/design choice, or the right approach isn\'t obvious), read enough to '
          + 'understand the task, then reply with a short numbered plan as TEXT and STOP — do not edit '
          + 'yet. Wait for the user to confirm before acting. Skip this for small/obvious asks (a typo, '
          + 'a one-line fix, an explicitly detailed instruction) — just do those directly.\n'
          + clarifyFormat('no edits')
          + 'Otherwise skip the block and proceed with the task.',
        permission: {
          read: 'allow', list: 'allow', glob: 'allow', grep: 'allow',
          web_fetch: 'allow', web_search: 'allow',
          write: 'allow', edit: 'allow', bash: 'ask',
          move: 'allow', remove: 'allow', task: 'allow', todowrite: 'allow',
        },
      },

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
          + clarifyFormat('no plan')
          + 'Otherwise skip the block and output only the plan. Keep it tight and skimmable.',
        permission: {
          read: 'allow', list: 'allow', glob: 'allow', grep: 'allow',
          web_fetch: 'allow', web_search: 'allow',
          write: 'deny', edit: 'deny', bash: 'deny',
          move: 'deny', remove: 'deny', task: 'deny', todowrite: 'deny', code_execution: 'deny',
        },
      },
    },

    ...(opts.instructionsPaths?.length ? { instructions: opts.instructionsPaths } : {}),
    ...(Object.keys(mcp).length ? { mcp } : {}),
  };
  return JSON.stringify(cfg);
}

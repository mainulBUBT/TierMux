

export type Platform =
  | 'google'
  | 'groq'
  | 'cerebras'
  | 'nvidia'
  | 'mistral'
  | 'openrouter'
  | 'github'
  | 'cohere'
  | 'cloudflare'
  | 'zhipu'
  | 'ollama'
  | 'kilo'
  | 'pollinations'
  | 'llm7'
  | 'huggingface'
  | 'opencode'
  | 'ovh'
  | 'agnes'
  | 'sambanova'
  | 'siliconflow'
  | 'zenmux'
  | 'kenari'
  | 'llmgateway'
  | 'poolside'
  | 'tokenrouter'
  | 'nararouter'
  | 'aionlabs'
  | 'chatanywhere'
  | 'openadapter'
  | 'orcarouter'
  | 'requesty'
  | 'router9'
  | 'xkiro'
  | 'airforce'
  | 'modelscope'
  | 'unorouter'
  | 'experientiallabs'
  | 'custom';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** TierMux's chat modes: plan (read-only, proposes concrete steps), agent (full read/write/run),
 *  ask (everything EXCEPT file edits — read/search/shell/sub-agents are all available so a
 *  question about git history or test output is answerable by running it; see MODE_TAIL.ask in
 *  context/system.ts). */
export type Mode = 'plan' | 'agent' | 'ask';

/** A plan proposed by the model via the `exitPlanMode` tool — validated structure straight off
 *  the tool call, so nothing downstream guesses whether a prose reply "was a plan". */
export interface ProposedPlanStep {
  /** The action, imperative mood, one line. */
  what: string;
  /** Workspace-relative paths this step touches — authoritative, not regex-guessed from prose. */
  files?: string[];
  /** The path:line the model actually READ that proves this step is needed. Surfaced on the card
   *  so a step resting on an unverified claim is visible BEFORE approval — the 2026-09-01 repro
   *  shipped "the query is double-constrained" as a step, which a read of the scope disproved. */
  evidence?: string;
  /** How to confirm the step landed (a command, or a check to re-read). */
  verify?: string;
}

export interface ProposedPlan {
  title: string;
  /** What the investigation concluded. 'no-change' renders as a finding, not as a step list —
   *  so "nothing needs changing" stops being expressible only as a fake verification step.
   *  Optional for back-compat: the prose fallback path (planStructurer) has no outcome. */
  outcome?: 'plan' | 'no-change';
  /** One or two sentences of context, rendered above the steps on the plan card. */
  description?: string;
  /** Set when outcome is 'no-change': what was checked and why nothing needs changing. */
  finding?: string;
  /** The reading of the request these steps implement, in one sentence, rendered at the top of
   *  the card — a plan can be right in every step and still implement the wrong request.
   *  Questions are asked BEFORE the plan via askUser, never carried on it. */
  interpretation?: string;
  steps: ProposedPlanStep[];
}

interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
  /** Streaming only: OpenAI-wire deltas identify the call slot by index when id is unset. */
  index?: number;
}

interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export type ChatContentBlock = string | { type?: string; text?: string; [key: string]: unknown };
export type ChatContent = string | null | ChatContentBlock[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  reasoning_content?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Reasoning / thinking tokens that are part of completion_tokens. */
  reasoning_tokens?: number;
}

interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: { platform: Platform; model: string };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: 'assistant'; content?: string; tool_calls?: ChatToolCall[] };
    finish_reason: string | null;
  }[];
  /** Provider usage object; typically present on the final chunk when
   *  `stream_options: { include_usage: true }` is sent. */
  usage?: TokenUsage;
}

export interface CatalogModel {
  platform: Platform;
  modelId: string;
  displayName: string;
  /** Lower is "smarter" (1 = frontier). Used to seed default priority. */
  intelligenceRank: number;
  /** Lower is "faster" (1 = fastest). Used to pick a completion model. */
  speedRank: number;
  /** Release / catalog-add month as "YYYY-MM" — a tiebreaker in defaultFallback (newer first
   *  among equals). Models without it sort as oldest. */
  released?: string;
  sizeLabel: string;
  contextWindow: number | null;
  /** Declared max OUTPUT tokens (models.dev-style limit.output). Null/undefined = unknown. */
  outputTokenLimit?: number | null;
  rpmLimit: number | null;
  rpdLimit: number | null;
  monthlyTokenBudget: string;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  /** True when this model refuses a whole turn on seeing a raw PDF `file` part (observed
   *  with gemini-2.5-flash: "I cannot process PDF file input") even though `supportsVision`
   *  is true — it can see images, just not PDF-typed file blocks. Routing avoids picking it
   *  for a turn whose PDF had no extractable text (so a raw file part is the only option). */
  rejectsRawPdf?: boolean;
  /** Optional free-form labels from the remote catalog (e.g. ["frontier","coding"]). */
  tags?: string[];
  /** Optional short editorial note shown beside the model (e.g. "Crowd favorite"). */
  insight?: string;
  /** Original (non-free) provider's per-1M-token input price, USD. Undefined if unpublished. */
  origInputPricePer1M?: number;
  /** Original (non-free) provider's per-1M-token output price, USD. Undefined if unpublished. */
  origOutputPricePer1M?: number;
  /** false = staged: no "new model added" notification and not enabled by default. Defaults
   *  to true when the source row has no column. */
  ready?: boolean;
}

/** One entry in the agent's live task list (TodoWrite-style progress tracking). */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown' | 'missing';

/** One entry in the ordered failover chain (persisted to globalState). */
export interface FallbackEntry {
  platform: Platform;
  modelId: string;
  enabled: boolean;
  priority: number; // lower = tried first
  key?: string; // API key for this model (overrides global platform key)
}

export interface PlatformInfo {
  platform: Platform;
  name: string;
  /** Default base URL for this platform's OpenAI-compatible endpoint. */
  defaultBaseUrl: string;
  /** True when the free tier needs no API key. */
  keyless: boolean;
  /** The platform serves a free tier anonymously AND a paid tier behind a key (OpenCode Zen).
   *  Unlike `keyless`, key entry stays available; a stored key is preferred. */
  keyOptional?: boolean;
  /** Help URL for obtaining a key. */
  keyUrl?: string;
}

/** A user-added model under a custom OpenAI-compatible endpoint. */
export interface CustomModel {
  /** Upstream model ID (must NOT contain '::'). */
  modelId: string;
  /** User-visible label. Falls back to modelId when empty. */
  displayName?: string;
  /** Explicit capability overrides for a custom model (no catalog entry to learn them from).
   *  Undefined = the old guess (tools true, vision/reasoning false, vision by id heuristic). */
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  /**
   * Tags, same vocabulary as CatalogModel.tags — the user's own labels for a custom model,
   * ticked in the add-endpoint form. Display-only; routing reads the capability booleans.
   */
  tags?: string[];
}

/** Which wire protocol a custom endpoint speaks. Undefined means 'openai-chat' — the
 *  original (and only, pre-2026-09) shape every existing saved endpoint already uses, so
 *  this stays optional rather than a required field with a migration. */
export type CustomEndpointType = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** A user-defined custom endpoint. Despite the name, not always OpenAI-compatible any more —
 *  see `type`. */
export interface CustomEndpoint {
  /** Stable ID (generated as 'c_' + 6 base36 chars). */
  id: string;
  /** User-chosen display name (must be unique among custom endpoints). */
  name: string;
  /** Base URL (validated http(s)://, trailing slash stripped). */
  baseUrl: string;
  /** Wire protocol this endpoint speaks. Defaults to 'openai-chat' when unset (see the type doc). */
  type?: CustomEndpointType;
  /** Optional default headers (e.g., Cloudflare AI Gateway custom header). */
  extraHeaders?: Record<string, string>;
  /** Models the user wants to expose under this endpoint. */
  models: CustomModel[];
  /** Unix-ms when created. */
  createdAt: number;
}

// ── Plan execution state (first-class plan runner) ─────────────────────────────
// An approved plan runs as a tracked state machine, persisted with the session so an
// interrupted run (window reload, extension restart) can resume from `currentStep`
// instead of restarting or silently vanishing. Pure data — no engine imports here.

/** One step of an executing plan. */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export interface PlanStep {
  text: string;
  status: PlanStepStatus;
  /** Execution attempts on this step (verify-failed retries). */
  attempts: number;
}

export type PlanRunStatus = 'running' | 'paused' | 'done' | 'failed' | 'aborted';
export interface PlanRunState {
  id: string;
  /** The user's original request the plan was approved for (first ~200 chars). */
  originalTask: string;
  steps: PlanStep[];
  /** Index of the step being executed / next to execute. */
  currentStep: number;
  status: PlanRunStatus;
  /** Plan repairs consumed (read-only planner rewrites of the remaining steps). */
  repairs: number;
  startedAt: number;
  updatedAt: number;
}

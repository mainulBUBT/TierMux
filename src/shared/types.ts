

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
  | 'custom';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** The three TierMux chat modes (mapped to OC agents + routing profiles). */
export type Mode = 'chat' | 'plan' | 'agent';

interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
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
  /**
   * Release / catalog-add month as "YYYY-MM". Used only as a routing tiebreaker:
   * among models the task rates equally, the newer one is preferred so freshly
   * added models surface instead of older equals winning every time. Optional —
   * models without it sort as oldest.
   */
  released?: string;
  sizeLabel: string;
  contextWindow: number | null;
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
  /**
   * When false, the model is staged: it does NOT trigger the "new model added"
   * notification, so you can add/test it in the remote sheet while developing without
   * alerting users. Flip to true (or omit the column) to publish. Defaults to true
   * when the source row doesn't carry the column.
   */
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
  /** Help URL for obtaining a key. */
  keyUrl?: string;
}

/** A user-added model under a custom OpenAI-compatible endpoint. */
export interface CustomModel {
  /** Upstream model ID (must NOT contain '::'). */
  modelId: string;
  /** User-visible label. Falls back to modelId when empty. */
  displayName?: string;
}

/** A user-defined OpenAI-compatible endpoint. */
export interface CustomEndpoint {
  /** Stable ID (generated as 'c_' + 6 base36 chars). */
  id: string;
  /** User-chosen display name (must be unique among custom endpoints). */
  name: string;
  /** Base URL (validated http(s)://, trailing slash stripped). */
  baseUrl: string;
  /** Optional default headers (e.g., Cloudflare AI Gateway custom header). */
  extraHeaders?: Record<string, string>;
  /** Models the user wants to expose under this endpoint. */
  models: CustomModel[];
  /** Unix-ms when created. */
  createdAt: number;
}

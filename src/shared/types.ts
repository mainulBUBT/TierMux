// Shared types for tiermux. Ported/adapted from freellmapi's
// shared/types.ts (MIT, https://github.com/tashfeenahmed/freellmapi) and
// trimmed to what the extension needs. OpenAI-compatible chat shapes are the
// neutral wire format; the Gemini adapter translates to/from this.

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
  | 'custom';

// 'xhigh' ("Very High") is our own extra tier; the OpenAI-wire reasoning_effort
// field caps at 'high', so providers map it down (Gemini uses a larger budget).
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

// ---- OpenAI-compatible chat types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
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
}

export interface ChatCompletionChoice {
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
}

// ---- Catalog & config ----

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
  /** Optional free-form labels from the remote catalog (e.g. ["frontier","coding"]). */
  tags?: string[];
  /** Optional short editorial note shown beside the model (e.g. "Crowd favorite"). */
  insight?: string;
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

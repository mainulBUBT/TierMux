// Wire protocol between the extension host and the chat webview.
import type { CatalogModel, FallbackEntry, KeyStatus, Platform, ReasoningEffort, TodoItem } from './shared/types';
import type { ClarifyingQuestion } from './agent/clarify';

/**
 * Anything a user attaches to a message. Three sending modes:
 *  - 'file' / 'doc' / 'pdf' carry extracted `text` so any text model can answer.
 *  - 'image' / 'pdf' additionally carry a `dataUrl` so a vision-capable model
 *    (Gemini, Groq Vision, Pixtral, …) can also see the original. For PDFs on
 *    Gemini the dataUrl is the canonical "send the PDF as-is" path; everywhere
 *    else the text is the source of truth and the dataUrl is ignored.
 */
export type AttachmentKind = 'file' | 'image' | 'pdf' | 'doc';

export interface Attachment {
  kind: AttachmentKind;
  name: string;
  /** For text-bearing kinds: the extracted text (capped). */
  text?: string;
  /** For image / PDF: a data: URL. */
  dataUrl?: string;
  /** MIME type, used by the provider to decide between file and text parts. */
  mime?: string;
  /** Bytes — used by the agent's read_image / read_document tools to re-open the file. */
  fsPath?: string;
  /** How the user got this attachment into the chip — used only for UI hints. */
  source?: 'paste' | 'drop' | 'pick' | 'tool';
}

export interface UsagePayload {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type UsageTotals = UsagePayload & {
  requests: number;
  /** Estimated current conversation size vs the active model's window. */
  context?: { tokens: number; window: number };
};

export interface KeyStatusInfo {
  platform: Platform;
  name: string;
  configured: boolean;
  keyless: boolean;
  status: KeyStatus;
  keyUrl?: string;
  defaultBaseUrl: string;
  endpoint?: string;
  /** Number of API keys stored for this platform (0 = none, >1 = rotation pool). */
  keyCount: number;
  /** Masked key hints for display, e.g. `["sk-ab••••7890", "sk-xy••••1234"]`. */
  keyHints: string[];
}

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'error' | 'disabled';
  toolCount: number;
  tools: string[];
  error?: string;
}

export interface McpRegistryItem {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Array<{ key: string; label?: string; password?: boolean }>;
  homepage?: string;
  /** 'http' for remote streamable-HTTP servers; otherwise stdio. */
  transport?: 'stdio' | 'http';
  url?: string;
  headers?: Array<{ name: string; value: string; secret?: boolean }>;
}

export interface CheckpointFile {
  uri: string;
  rel: string;
  status: 'created' | 'modified' | 'deleted';
}

export interface IndexInfo {
  enabled: boolean;
  built: boolean;
  files: number;
  chunks: number;
  model: string;
  building: boolean;
  lastError?: string;
  provider: string;
  providerConfigured: boolean;
}

export interface ConfigPayload {
  catalog: CatalogModel[];
  fallback: FallbackEntry[];
  platforms: KeyStatusInfo[];
  mcp: McpServerInfo[];
  mcpRegistry: McpRegistryItem[];
  index: IndexInfo;
  /** `platform::modelId` keys a provider has 404'd this session — flagged as deprecated in the picker. */
  deprecated: string[];
  /** `platform::modelId` keys currently set as a per-model override of the platform key. */
  modelKeys: string[];
  /** Selected model for utility tasks (titles, commit messages); 'auto' = keyless-preferred. */
  utilityModel: string;
  /** Session toggle: when true, the agent runs commands and applies edits without asking (dangerous commands still confirm). */
  autoApprove: boolean;
  /** Web search provider status — which keys are set and which provider is tried first. */
  searchProviders: SearchProviderStatus[];
  searchPriority: string;
  /** Providers toggled off at the platform level — models excluded from routing and pickers without losing their enabled flags. */
  disabledProviders: Platform[];
}

export interface SearchProviderStatus {
  id: 'exa' | 'brave' | 'custom' | 'duckduckgo';
  name: string;
  hasKey: boolean;
  freeTier: string;
  signupUrl?: string;
}

export interface MentionItem {
  label: string;
  insert: string;
  kind: 'file' | 'folder' | 'symbol';
  detail?: string;
}

// Webview -> Extension
export type InMessage =
  | { type: 'ready' }
  | { type: 'sendMessage'; requestId: string; text: string; mode: 'chat' | 'plan' | 'agent'; model: string; reasoningEffort: ReasoningEffort; attachments?: Attachment[]; attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'> }
  | { type: 'approvePlan'; requestId: string; approved: boolean; steps: string }
  | { type: 'deferPlan'; requestId: string; steps: string }
  | { type: 'answerClarifying'; requestId: string; answers: string[] }
  | { type: 'renameSession'; title: string }
  | { type: 'vote'; requestId: string; vote: 'up' | 'down' | 'none' }
  | { type: 'cancel'; requestId: string; sessionId?: string }
  | { type: 'commandApprovalResponse'; id: string; approved: boolean; sessionId?: string }
  | { type: 'editApprovalResponse'; id: string; approved: boolean; sessionId?: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'requestConfig' }
  | { type: 'setFallbackConfig'; entries: FallbackEntry[] }
  | { type: 'setEndpoint'; platform: Platform; url: string }
  | { type: 'resetEndpoint'; platform: Platform }
  | { type: 'setKey'; platform: Platform }
  | { type: 'addKey'; platform: Platform }
  | { type: 'removeKeyAt'; platform: Platform; index: number }
  | { type: 'setProviderEnabled'; platform: Platform; enabled: boolean }
  | { type: 'setModelKey'; platform: Platform; modelId: string; key: string }
  | { type: 'clearModelKey'; platform: Platform; modelId: string }
  | { type: 'attachFromWorkspace' }
  | { type: 'attachFromDataUrl'; name: string; mime: string; dataUrl: string; source?: 'paste' | 'drop' }
  | { type: 'addSelection' }
  | { type: 'mentionQuery'; queryId: number; query: string }
  | { type: 'compact' }
  | { type: 'editMcp' }
  | { type: 'reconnectMcp' }
  | { type: 'addMcpServer'; item: McpRegistryItem }
  | { type: 'removeMcpServer'; name: string }
  | { type: 'searchMcpRegistry'; queryId: number; query: string }
  | { type: 'buildIndex' }
  | { type: 'clearIndex' }
  | { type: 'restoreCheckpoint'; id: string }
  | { type: 'diffCheckpointFile'; id: string; uri: string }
  | { type: 'revertTo'; requestId: string }
  | { type: 'copyText'; text: string }
  | { type: 'setEmbeddingsEnabled'; enabled: boolean }
  | { type: 'setEmbeddingsProvider'; provider: string }
  | { type: 'setUtilityModel'; model: string }
  | { type: 'setSearchKey'; provider: string; key?: string }
  | { type: 'setSearchPriority'; priority: string }
  | { type: 'setAutoApprove'; enabled: boolean }
  | { type: 'resume'; requestId: string }
  | { type: 'newChat' }
  | { type: 'askUserResponse'; requestId: string; callId: string; answer: string; cancelled?: boolean; sessionId?: string };

/** A single tool step shown inside a turn's "Worked for Ns" disclosure. Mirrors the live
 *  `toolStatus` event so a re-rendered (e.g. post-revert) message can rebuild its step list. */
export interface TranscriptStep {
  toolCallId: string;
  name: string;
  args?: unknown;
  state?: 'running' | 'done' | 'error';
  detail?: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  model?: string;
  /** Present on user turns — lets the webview re-track a command for "Revert to here". */
  requestId?: string;
  /** Epoch ms when the turn was recorded, for message timestamps. */
  ts?: number;
  /** How long the assistant turn took (seconds) — shown in the footer after restore. */
  secs?: number;
  /** `s.history.length` captured just before this user turn was pushed, so "Revert to here"
   *  can truncate history back to this point without dropping earlier tool calls/results. */
  historyLen?: number;
  /** Assistant reasoning text — replayed as the "Reasoning" disclosure on re-render. */
  reasoning?: string;
  /** Assistant turn token usage — replayed in the footer on re-render. */
  usage?: { promptTokens: number; completionTokens: number };
  /** Tool steps for the "Worked for Ns" disclosure — replayed on re-render. */
  steps?: TranscriptStep[];
}

/** Live status of a session, shown as a dot on its tab. */
export type SessionStatus = 'idle' | 'queued' | 'running' | 'needsApproval' | 'finished';

// Extension -> Webview
export type OutMessage =
  | { type: 'config'; config: ConfigPayload; usageTotals: UsageTotals }
  | { type: 'sessionList'; sessions: Array<{ id: string; title: string; status: SessionStatus }> }
  | { type: 'switchSession'; sessionId: string; messages: TranscriptMessage[] }
  | { type: 'userEcho'; sessionId: string; requestId: string; text: string }
  | { type: 'assistantStart'; sessionId: string; requestId: string; platform: string; model: string }
  | { type: 'planProposed'; sessionId: string; requestId: string; steps: string; discarded?: boolean; deferred?: boolean }
  | { type: 'planDiscarded'; sessionId: string; requestId: string }
  | { type: 'commandApproval'; sessionId: string; requestId: string; id: string; command: string; cwd?: string }
  | { type: 'editApproval'; sessionId: string; requestId: string; id: string; path: string; title: string; kind: 'write' | 'delete' }
  | { type: 'clarifyingQuestions'; sessionId: string; requestId: string; questions: ClarifyingQuestion[] }
  | { type: 'sessionTitle'; sessionId: string; title: string }
  | { type: 'assistantMessage'; sessionId: string; requestId: string; text: string; reasoning?: string; usage?: UsagePayload; platform?: string; model?: string; paused?: boolean }
  | { type: 'usageTotals'; totals: UsageTotals }
  | { type: 'indexProgress'; building: boolean; done: number; total: number; phase: 'scanning' | 'embedding' | 'done' | 'error' }
  | { type: 'checkpoint'; sessionId: string; requestId: string; id: string; files: CheckpointFile[] }
  | { type: 'toolStatus'; sessionId: string; requestId: string; toolCallId: string; name: string; args: unknown; state: 'running' | 'done' | 'error'; detail?: string }
  | { type: 'changedFiles'; sessionId: string; id: string; files: CheckpointFile[] }
  | { type: 'agentStep'; sessionId: string; requestId: string; phase: 'thinking' | 'synthesizing' | 'done'; label: string }
  | { type: 'askUserPrompt'; sessionId: string; requestId: string; callId: string; question: string; options?: string[] }
  | { type: 'askUserDismissed'; sessionId: string; requestId: string; callId: string }
  | { type: 'todos'; sessionId: string; requestId: string; todos: TodoItem[]; followingPlan?: boolean }
  | { type: 'failoverNotice'; sessionId: string; requestId: string; from: string; reason: string }
  | { type: 'keyRotated'; sessionId: string; requestId: string; platform: string; platformName: string; keyIndex: number; keyTotal: number }
  | { type: 'attachmentAdded'; attachment: Attachment }
  | { type: 'mentionResults'; queryId: number; items: MentionItem[] }
  | { type: 'mcpRegistryResults'; queryId: number; items: McpRegistryItem[]; error?: string }
  | { type: 'setInput'; text: string }
  | { type: 'toggleSettings' }
  | { type: 'notice'; sessionId: string; text: string }
  | { type: 'error'; sessionId?: string; requestId?: string; message: string }
  | { type: 'busy'; sessionId: string; busy: boolean };

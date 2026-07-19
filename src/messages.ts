// Wire protocol between the extension host and the chat webview.
import type { CatalogModel, FallbackEntry, KeyStatus, Platform, ReasoningEffort, TodoItem } from './shared/types';
import type { ClarifyingQuestion } from './agent/clarify';
import type { McpServerConfig } from './mcp/mcpClient';
export type { McpServerConfig, McpLocalServerConfig, McpRemoteServerConfig, McpOAuthConfig } from './mcp/mcpClient';

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
  reasoningTokens?: number;
  totalTokens: number;
}

export type UsageTotals = UsagePayload & {
  requests: number;
  /** Estimated current conversation size vs the active model's window. */
  context?: { tokens: number; window: number };
  /** Persistent across-reload totals (see UsageStore). Optional so older callers
   *  that pre-date the lifetime field still type-check. */
  lifetime?: {
    totalTokens: number;
    totalRequests: number;
    estimatedSavingsUsd: number;
    firstRecordedAt: number;
    totalReasoningTokens?: number;
  };
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
  /** Cloudflare account ID (masked hint), when set separately from the API token. */
  cloudflareAccountId?: string;
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

/** Describes one row in the "Others" settings tab. The array itself lives in
 *  `src/settingsMeta.ts` (host-only, sent over the wire) so the webview never
 *  keeps its own copy of the key list. */
export interface SettingMeta {
  key: string;
  label: string;
  desc: string;
  type: 'boolean' | 'enum' | 'number' | 'string';
  enum?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export interface ConfigPayload {
  catalog: CatalogModel[];
  fallback: FallbackEntry[];
  platforms: KeyStatusInfo[];
  mcp: McpServerInfo[];
  /** Raw persisted config per server (from `tiermux.mcpServers`, already-migrated shape) —
   *  used to pre-fill the Edit form; connection status/tools live in `mcp` above. */
  mcpServers: Record<string, McpServerConfig>;
  mcpRegistry: McpRegistryItem[];
  /** `platform::modelId` keys a provider has 404'd this session — flagged as deprecated in the picker. */
  deprecated: string[];
  /** `platform::modelId` keys currently labeled slow (a recent request was ≥8s) — deprioritized in Auto for 30 min, flagged in the picker. */
  slow: string[];
  /** `platform::modelId` keys currently set as a per-model override of the platform key. */
  modelKeys: string[];
  /** Selected model for utility tasks (titles, commit messages); 'auto' = keyless-preferred. */
  utilityModel: string;
  /** Row definitions for the "Others" tab generic settings editor. */
  settingsMeta: SettingMeta[];
  /** Current value of every key in `settingsMeta`, read live from `tiermux.*` config. */
  settings: Record<string, boolean | number | string>;
  /** Session toggle: when true, the agent runs commands and applies edits without asking (dangerous commands still confirm). */
  autoApprove: boolean;
  /** Providers toggled off at the platform level — models excluded from routing and pickers without losing their enabled flags. */
  disabledProviders: Platform[];
  /** User-defined custom OpenAI-compatible endpoints (summary — the webview reads fallback chain for enabled models). */
  customEndpoints: Array<{
    id: string;
    name: string;
    baseUrl: string;
    keyless: boolean;
    configured: boolean;
    modelCount: number;
  }>;
  /** Slash-command skill index (name + one-line description) loaded from
   *  .tiermux/skills/*.md — the webview's `/` autocomplete renders this list.
   *  Full skill body text is never sent here; only the matched skill's prompt
   *  is substituted server-side when the user actually sends `/name`. */
  skills: Array<{ name: string; detail: string }>;
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
  | { type: 'sendMessage'; requestId: string; text: string; mode: 'plan' | 'agent' | 'ask'; model: string; reasoningEffort: ReasoningEffort; attachments?: Attachment[]; attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'> }
  | { type: 'approvePlan'; requestId: string; approved: boolean; steps: string }
  | { type: 'deferPlan'; requestId: string; steps: string }
  | { type: 'answerClarifying'; requestId: string; answers: string[] }
  | { type: 'renameSession'; title: string }
  | { type: 'renameSessionById'; sessionId: string; title: string }
  | { type: 'deleteSessionById'; sessionId: string }
  | { type: 'vote'; requestId: string; vote: 'up' | 'down' | 'none' }
  | { type: 'cancel'; requestId: string; sessionId?: string }
  | { type: 'commandApprovalResponse'; id: string; approved: boolean; sessionId?: string }
  | { type: 'editApprovalResponse'; id: string; approved: boolean; sessionId?: string }
  | { type: 'permissionAskResponse'; id: string; response: 'once' | 'always' | 'reject'; sessionId?: string }
  /** Watchdog action button click. `continueWaiting` is a client-side dismissal + log only —
   *  the SDK never receives a decision back (see sdk.ts's watchdog design). */
  | { type: 'watchdogAction'; requestId: string; action: 'continueWaiting' | 'restartRequest' | 'switchModel' | 'acceptCurrentOutput'; sessionId?: string }
  | { type: 'openOcDiff'; sessionId: string; file: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'requestConfig' }
  | { type: 'setFallbackConfig'; entries: FallbackEntry[] }
  | { type: 'setEndpoint'; platform: Platform; url: string }
  | { type: 'resetEndpoint'; platform: Platform }
  | { type: 'setKey'; platform: Platform }
  | { type: 'addKey'; platform: Platform }
  | { type: 'removeKeyAt'; platform: Platform; index: number }
  | { type: 'setCloudflareAccountId'; accountId: string }
  | { type: 'clearCloudflareAccountId' }
  | { type: 'setProviderEnabled'; platform: Platform; enabled: boolean }
  | { type: 'setModelKey'; platform: Platform; modelId: string; key: string }
  | { type: 'clearModelKey'; platform: Platform; modelId: string }
  | { type: 'attachFromWorkspace' }
  | { type: 'attachFromDataUrl'; name: string; mime: string; dataUrl: string; source?: 'paste' | 'drop' }
  | { type: 'addSelection' }
  | { type: 'mentionQuery'; queryId: number; query: string }
  | { type: 'grepQuery'; queryId: number; query: string }
  | { type: 'openGrepResult'; path: string; line: number }
  | { type: 'compact' }
  | { type: 'editMcp' }
  | { type: 'reconnectMcp' }
  | { type: 'addMcpServer'; item: McpRegistryItem }
  | { type: 'removeMcpServer'; name: string }
  /** Unified Add/Edit save from the MCP form. `originalName` set (and different from
   *  `name`) means a rename — the old key is removed and the new one added. */
  | { type: 'saveMcpServer'; name: string; originalName?: string; config: McpServerConfig }
  | { type: 'setMcpServerEnabled'; name: string; enabled: boolean }
  | { type: 'searchMcpRegistry'; queryId: number; query: string }
  | { type: 'restoreCheckpoint'; id: string }
  | { type: 'diffCheckpointFile'; id: string; uri: string }
  | { type: 'revertTo'; requestId: string }
  | { type: 'copyText'; text: string }
  | { type: 'setUtilityModel'; model: string }
  | { type: 'setExtensionSetting'; key: string; value: boolean | number | string }
  | { type: 'openKeybinding'; command: string }
  | { type: 'setAutoApprove'; enabled: boolean }
  | { type: 'resume'; requestId: string }
  | { type: 'newChat' }
  | { type: 'askUserResponse'; requestId: string; callId: string; answer: string; cancelled?: boolean; sessionId?: string }
  | { type: 'clearUsage' }
  // Custom OpenAI-compatible endpoints
  | { type: 'addCustomEndpoint'; name: string; baseUrl: string }
  | { type: 'updateCustomEndpoint'; id: string; name?: string; baseUrl?: string; extraHeaders?: Record<string, string> }
  | { type: 'removeCustomEndpoint'; id: string }
  | { type: 'setCustomEndpointKey'; id: string; key: string | null }
  | { type: 'addCustomModel'; endpointId: string; modelId: string; displayName?: string }
  | { type: 'removeCustomModel'; endpointId: string; modelId: string }
  /** Ask the host to GET <baseUrl>/models for an endpoint and stream back the model IDs (Kilo/Cline-style auto-discovery). */
  | { type: 'fetchCustomEndpointModels'; id: string }
  /** Onboarding "Retry" button — re-attempt the OC engine startup. */
  | { type: 'retryEngine' };

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
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
  /** Tool steps for the "Worked for Ns" disclosure — replayed on re-render. */
  steps?: TranscriptStep[];
  /** Present on user turns that had one — replayed as attachment chips on re-render
   *  (session switch/reload) and restored to the composer by "Revert to here". */
  attachments?: Attachment[];
}

/** Live status of a session, shown as a dot on its tab. */
export type SessionStatus = 'idle' | 'queued' | 'running' | 'needsApproval' | 'finished';

// Extension -> Webview
export type OutMessage =
  | { type: 'config'; config: ConfigPayload; usageTotals: UsageTotals }
  | { type: 'sessionList'; sessions: Array<{ id: string; title: string; status: SessionStatus; activity?: string; createdAt?: number; updatedAt?: number }> }
  | { type: 'switchSession'; sessionId: string; messages: TranscriptMessage[] }
  | { type: 'userEcho'; sessionId: string; requestId: string; text: string }
  | { type: 'assistantStart'; sessionId: string; requestId: string; platform: string; model: string }
  | { type: 'planProposed'; sessionId: string; requestId: string; steps: string; discarded?: boolean; deferred?: boolean }
  | { type: 'planDiscarded'; sessionId: string; requestId: string }
  | { type: 'commandApproval'; sessionId: string; requestId: string; id: string; command: string; cwd?: string }
  | { type: 'editApproval'; sessionId: string; requestId: string; id: string; path: string; title: string; kind: 'write' | 'delete' }
  | { type: 'permissionAsk'; sessionId: string; requestId: string; id: string; title: string; pattern?: string | string[] }
  | { type: 'ocSessionDiffList'; sessionId: string; requestId: string; files: Array<{ file: string; additions: number; deletions: number }> }
  | { type: 'clarifyingQuestions'; sessionId: string; requestId: string; questions: ClarifyingQuestion[] }
  | { type: 'sessionTitle'; sessionId: string; title: string }
  // `noFooter`: true when a clarifyingQuestions card immediately follows this message for the
  // SAME requestId — the model/usage footer is deferred to the eventual final answer bubble
  // (a new requestId, once the user answers) instead of showing on the question-asking turn.
  | { type: 'assistantMessage'; sessionId: string; requestId: string; text: string; reasoning?: string; usage?: UsagePayload; platform?: string; model?: string; paused?: boolean; noFooter?: boolean }
  | { type: 'assistantChunk'; sessionId: string; requestId: string; text: string }
  | { type: 'usageTotals'; totals: UsageTotals }
  | { type: 'checkpoint'; sessionId: string; requestId: string; id: string; files: CheckpointFile[] }
  | { type: 'toolStatus'; sessionId: string; requestId: string; toolCallId: string; name: string; args: unknown; state: 'running' | 'done' | 'error'; detail?: string }
  | { type: 'changedFiles'; sessionId: string; id: string; files: CheckpointFile[] }
  | { type: 'agentStep'; sessionId: string; requestId: string; phase: 'thinking' | 'synthesizing' | 'done'; label: string }
  /** Result of fetchCustomEndpointModels: the model IDs discovered at the endpoint (or an error). */
  | { type: 'customEndpointModels'; id: string; models: string[]; error?: string }
  | { type: 'askUserPrompt'; sessionId: string; requestId: string; callId: string; question: string; options?: string[] }
  | { type: 'askUserDismissed'; sessionId: string; requestId: string; callId: string }
  // The host force-settled a commandApproval/editApproval/permissionAsk card without a user
  // click (e.g. the run ended/was cancelled first) — `id` is globally unique across all three
  // card kinds (cmd-/edit-/perm- prefixes), so the webview can match it against whichever kind
  // is actually rendered without needing to know which.
  | { type: 'approvalDismissed'; sessionId: string; id: string }
  | { type: 'todos'; sessionId: string; requestId: string; todos: TodoItem[]; followingPlan?: boolean }
  | { type: 'failoverNotice'; sessionId: string; requestId: string; from: string; reason: string }
  /** Watchdog — observability only. Warning/actionable are non-blocking; `hasPartialOutput`
   *  gates whether "Accept Current Output" is offered. `dismissed` means real activity resumed
   *  and any warning/actionable UI for this request should be removed immediately. */
  | { type: 'watchdogWarning'; sessionId: string; requestId: string; elapsedMs: number; lastActivityLabel?: string; lastActivityAgeMs?: number }
  | { type: 'watchdogActionable'; sessionId: string; requestId: string; elapsedMs: number; lastActivityLabel?: string; lastActivityAgeMs?: number; hasPartialOutput: boolean }
  | { type: 'watchdogDismissed'; sessionId: string; requestId: string }
  | { type: 'selectionRationale'; sessionId: string; requestId: string; taskKind: string; picked?: string; entries: Array<{ model: string; selected: boolean; score: number; capability: number; runtime: number; preference: number; confidence: number; reason: string; skip?: string }> }
  | { type: 'keyRotated'; sessionId: string; requestId: string; platform: string; platformName: string; keyIndex: number; keyTotal: number }
  | { type: 'attachmentAdded'; attachment: Attachment }
  | { type: 'mentionResults'; queryId: number; items: MentionItem[] }
  | { type: 'grepResults'; queryId: number; items: Array<{ path: string; lineNumber: number; lineText: string }> }
  | { type: 'mcpRegistryResults'; queryId: number; items: McpRegistryItem[]; error?: string }
  | { type: 'setInput'; text: string; attachments?: Attachment[] }
  | { type: 'toggleSettings' }
  | { type: 'toggleHistory' }
  | { type: 'notice'; sessionId: string; text: string }
  | { type: 'error'; sessionId?: string; requestId?: string; message: string }
  | { type: 'busy'; sessionId: string; busy: boolean }
  /** First-run engine onboarding: binary download progress → verify → ready/error.
   *  Only sent while the engine hasn't been successfully onboarded before (see
   *  `tiermux.onboardedEngine` global state) — returning users never see this. */
  | { type: 'engineStatus'; state: 'downloading' | 'starting' | 'verifying' | 'ready' | 'error'; message?: string; percent?: number }
  | { type: 'newModelsAvailable'; message: string };

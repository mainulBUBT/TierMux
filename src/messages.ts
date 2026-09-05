// Wire protocol between the extension host and the chat webview.
import type { CatalogModel, CustomEndpointType, CustomModel, FallbackEntry, KeyStatus, Mode, Platform, PlanRunState, ReasoningEffort, TodoItem } from './shared/types';
import type { WorkReportData } from './shared/workReport';
import type { McpServerConfig } from './mcp/mcpClient';
export type { McpServerConfig, McpLocalServerConfig, McpRemoteServerConfig, McpOAuthConfig } from './mcp/mcpClient';

/** Anything a user attaches. 'file' / 'doc' / 'pdf' carry extracted `text` for any model;
 *  'image' / 'pdf' also carry a `dataUrl` for vision models. For PDFs on Gemini the dataUrl is
 *  the canonical path; elsewhere the text is the truth and the dataUrl is ignored. */
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
  /** Scanned/no-text-layer PDF only: each page rendered to a PNG data: URL. When present,
   *  these are sent as ordinary `image_url` blocks instead of the raw PDF file — every
   *  vision-capable model can read images, but only Google forwards raw PDF bytes. */
  pageImages?: string[];
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
  /** Platforms the shared worker catalog currently reports `enabled: false` for — surfaced
   *  in the provider toggle UI so a provider with zero catalog models reads as "disabled
   *  upstream" rather than "broken". Distinct from `disabledProviders`, which is the user's
   *  own local on/off choice. */
  remoteDisabledProviders: Platform[];
  /** User-defined custom OpenAI-compatible endpoints (summary — the webview reads fallback chain
   *  for enabled models; `models` carries per-model capability ticks, since a custom endpoint has
   *  no catalog entry the router could otherwise learn Tools/Vision/Reasoning support from). */
  customEndpoints: Array<{
    id: string;
    name: string;
    baseUrl: string;
    keyless: boolean;
    configured: boolean;
    modelCount: number;
    type?: CustomEndpointType;
    models: CustomModel[];
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
  | { type: 'sendMessage'; requestId: string; text: string; mode: Mode; model: string; reasoningEffort: ReasoningEffort; attachments?: Attachment[]; attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'> }
  | { type: 'approvePlan'; requestId: string; approved: boolean; steps: string }
  | { type: 'executePlan'; requestId: string; steps: string }
  | { type: 'deferPlan'; requestId: string; steps: string }
  | { type: 'renameSession'; title: string }
  | { type: 'renameSessionById'; sessionId: string; title: string }
  | { type: 'deleteSessionById'; sessionId: string }
  | { type: 'vote'; requestId: string; vote: 'up' | 'down' | 'none' }
  | { type: 'cancel'; requestId: string; sessionId?: string }
  | { type: 'editApprovalResponse'; id: string; approved: boolean; sessionId?: string }
  | { type: 'permissionAskResponse'; id: string; response: 'once' | 'always' | 'reject'; sessionId?: string }
  | { type: 'openPlanFile'; uri: string }
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
  | { type: 'addCustomEndpoint'; name: string; baseUrl: string; endpointType?: CustomEndpointType }
  | { type: 'updateCustomEndpoint'; id: string; name?: string; baseUrl?: string; extraHeaders?: Record<string, string>; endpointType?: CustomEndpointType }
  | { type: 'removeCustomEndpoint'; id: string }
  | { type: 'setCustomEndpointKey'; id: string; key: string | null }
  | { type: 'addCustomModel'; endpointId: string; modelId: string; displayName?: string; supportsTools?: boolean; supportsVision?: boolean; supportsReasoning?: boolean; tags?: string[] }
  | { type: 'removeCustomModel'; endpointId: string; modelId: string }
  /** Toggle one capability tick (Tools/Vision/Reasoning) on an already-added custom model —
   *  a custom endpoint has no catalog entry to learn these from, so the router trusts
   *  whatever is set here (see Router.customModelCaps). */
  | { type: 'setCustomModelCaps'; endpointId: string; modelId: string; supportsTools?: boolean; supportsVision?: boolean; supportsReasoning?: boolean }
  /** Ask the host to GET <baseUrl>/models for an endpoint and stream back the model IDs (Kilo/Cline-style auto-discovery). */
  | { type: 'fetchCustomEndpointModels'; id: string }
  /** Webview asks the host to (re)fetch tips/announcements from the worker and push them back. */
  | { type: 'getAnnouncements' }
  /** Mark announcements seen (clears the unseen dot). `ids` marks just those items — sent
   *  when a tip card is actually expanded, so the dot survives merely opening the page.
   *  Omitting `ids` marks everything ("Mark all read"). */
  | { type: 'markAnnouncementsSeen'; ids?: number[] }
  /** Resume a paused plan run (see planProgress) from its persisted step state. */
  | { type: 'resumePlan' };

/** A single tool step shown inside a turn's "Worked for Ns" disclosure. Mirrors the live
 *  `toolStatus` event so a re-rendered (e.g. post-revert) message can rebuild its step list. */
export interface TranscriptStep {
  toolCallId: string;
  name: string;
  args?: unknown;
  state?: 'running' | 'done' | 'error';
  detail?: string;
  /** Wall-clock time the call took to settle, in ms — see toolStatus's durationMs. Persisted
   *  here so a reopened/reverted-to turn shows the same per-step duration a live run did. */
  durationMs?: number;
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
  /** The turn's model-scoring rationale, as reported for the model that ACTUALLY served —
   *  replayed so the footer's "Why this model?" (?) survives a reload/session switch. Live-only
   *  before this field existed, so it silently vanished on every re-render. */
  rationale?: SelectionRationale;
  /** Structured end-of-turn report — the CANONICAL representation a replay renders as a
   *  ResultCard. When present, `.text` also carries the legacy markdown serialization
   *  (renderLegacyMarkdown) purely so pre-WorkReportData readers keep working; new code
   *  must render from here and never parse that markdown back. */
  workReport?: WorkReportData;
}

/** One scored candidate in the "Why this model?" panel. `model` is a display string
 *  ("Provider/model-id"), already resolved host-side. */
export interface SelectionRationaleEntry {
  model: string;
  selected: boolean;
  score: number;
  capability: number;
  runtime: number;
  preference: number;
  confidence: number;
  reason: string;
  skip?: string;
}

/** The scoring rationale for one turn — what the (?) popover renders. */
export interface SelectionRationale {
  picked?: string;
  entries: SelectionRationaleEntry[];
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
  | { type: 'editApproval'; sessionId: string; requestId: string; id: string; path: string; title: string; kind: 'write' | 'delete' }
  | { type: 'permissionAsk'; sessionId: string; requestId: string; id: string; title: string; pattern?: string | string[] }
  | { type: 'sessionTitle'; sessionId: string; title: string }
  | { type: 'assistantMessage'; sessionId: string; requestId: string; text: string; reasoning?: string; finishReason?: string; usage?: UsagePayload; platform?: string; model?: string; paused?: boolean }
  // Structured end-of-turn report — posted right after the assistantMessage it belongs to.
  // The webview mounts a ResultCard on the live turn target AND stores it for replay parity
  // (same component renders both paths). `text` in the paired assistantMessage deliberately
  // carries NO report markdown — the card replaces that legacy serialization.
  | { type: 'workReport'; sessionId: string; requestId: string; report: WorkReportData }
  | { type: 'assistantChunk'; sessionId: string; requestId: string; text: string }
  // Retract the live text draft: a tool call arrived in the same step, so the streamed text was
  // narration, not the reply. The webview converts the draft node into the reasoning block
  // `reasoningId` in place, so it doesn't vanish and re-appear.
  | { type: 'clearDraft'; sessionId: string; requestId: string; reasoningId?: string }
  | { type: 'usageTotals'; totals: UsageTotals }
  | { type: 'checkpoint'; sessionId: string; requestId: string; id: string; files: CheckpointFile[] }
  | { type: 'toolStatus'; sessionId: string; requestId: string; toolCallId: string; name: string; args: unknown; state: 'running' | 'done' | 'error'; detail?: string; durationMs?: number }
  | { type: 'changedFiles'; sessionId: string; id: string; files: CheckpointFile[] }
  | { type: 'agentStep'; sessionId: string; requestId: string; phase: 'thinking' | 'synthesizing' | 'done'; label: string }
  /** Result of fetchCustomEndpointModels: the model IDs discovered at the endpoint (or an error). */
  | { type: 'customEndpointModels'; id: string; models: string[]; error?: string }
  | { type: 'askUserPrompt'; sessionId: string; requestId: string; callId: string; question: string; options?: string[] }
  | { type: 'askUserDismissed'; sessionId: string; requestId: string; callId: string }
  // The host force-settled an editApproval/permissionAsk card without a user
  // click (e.g. the run ended/was cancelled first) — `id` is globally unique across all three
  // card kinds (cmd-/edit-/perm- prefixes), so the webview can match it against whichever kind
  // is actually rendered without needing to know which.
  | { type: 'approvalDismissed'; sessionId: string; id: string }
  | { type: 'todos'; sessionId: string; requestId: string; todos: TodoItem[]; followingPlan?: boolean }
  /** AI Elements Plan component — the rich, sectioned progress card shown while an approved
   *  plan executes (plan mode). Derived from the same `TodoItem[]` source as `todos`, so the
   *  two stay in sync; the webview picks Plan vs legacy todo-list by current mode. */
  | { type: 'planData'; sessionId: string; requestId: string; data: PlanDataPayload }
  | { type: 'failoverNotice'; sessionId: string; requestId: string; from: string; reason: string }
  | { type: 'selectionRationale'; sessionId: string; requestId: string; taskKind: string; picked?: string; entries: SelectionRationaleEntry[] }
  | { type: 'keyRotated'; sessionId: string; requestId: string; platform: string; platformName: string; keyIndex: number; keyTotal: number }
  | { type: 'attachmentAdded'; attachment: Attachment }
  | { type: 'insertMention'; text: string }
  /** Host→webview hint that a mention was inserted (see openFilePicker flows). */
  | { type: 'mentionResults'; queryId: number; items: MentionItem[] }
  | { type: 'grepResults'; queryId: number; items: Array<{ path: string; lineNumber: number; lineText: string }> }
  | { type: 'mcpRegistryResults'; queryId: number; items: McpRegistryItem[]; error?: string }
  | { type: 'setInput'; text: string; attachments?: Attachment[] }
  | { type: 'toggleSettings' }
  | { type: 'toggleHistory' }
  /** `icon` names a key in the webview's ICON set (media/src/icons.ts) — TierMux's own stroke-SVG
   *  style, never a raw emoji glyph in `text`. Omit for a plain notice with no leading icon. */
  | { type: 'notice'; sessionId: string; text: string; icon?: 'check' | 'clipboard' | 'save' | 'compress' | 'trash' | 'revert'; action?: { kind: 'openPlanFile'; uri: string } }
  /** Visual-only: an approved plan's execution window, keyed by requestId so an overlapping
   *  or stale `executing:false` from a different run can never clear the wrong indicator. */
  | { type: 'planExecuting'; sessionId: string; requestId: string; executing: boolean }
  /** Host-driven mode switch (e.g. executing an approved plan flips the user's mode to Agent).
   *  Unlike planExecuting (visual-only), this updates the user's actual mode selection. */
  | { type: 'setMode'; sessionId: string; mode: Mode }
  | { type: 'error'; sessionId?: string; requestId?: string; message: string }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'newModelsAvailable'; message: string }
  /** Dismissible "new providers available" banner above the composer — mirrors the
   *  models banner but fires when a brand-new provider is merged in from the remote catalog. */
  | { type: 'newProvidersAvailable'; message: string }
  /** Operator-published tips/announcements, fetched from the announcements worker
   *  (see ChatViewProvider.fetchAnnouncements). Pushed on startup and on icon click.
   *  Items are newest-first; `unseen` drives the dot on the toolbar icon and `unseenIds`
   *  badges the individual cards that haven't been read yet. */
  | { type: 'announcements'; items: AnnouncementItem[]; lastUpdated?: string; unseen: number; unseenIds: number[] }
  /** Open the Tips page (from the "new announcement" toast's View button). */
  | { type: 'openAnnouncements' }
  /** Live state of a first-class plan execution (see core/planRunner.ts). Posted after every
   *  step transition; `status: 'paused'` renders the Resume button in the webview. */
  | { type: 'planProgress'; sessionId: string; requestId: string; state: PlanRunState };

/** A single tip/announcement entry from the announcements worker. */
export interface AnnouncementItem {
  id: number;
  title: string;
  details: string;
}

/** Payload for the AI Elements Plan component — mirrors `PlanData` in media/src/ui/components/Plan.ts. */
export interface PlanDataPayload {
  id: string;
  title: string;
  sections: Array<{
    id: string;
    title: string;
    tasks: Array<{ id: string; title: string; completed: boolean; pending?: boolean; error?: boolean; running?: boolean }>;
  }>;
  createdAt: number;
  completedTasks: number;
  totalTasks: number;
}

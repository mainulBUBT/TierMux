// Wire protocol between the extension host and the chat webview.
import type { CatalogModel, FallbackEntry, KeyStatus, Platform, ReasoningEffort, TodoItem } from './shared/types';
import type { ClarifyingQuestion } from './agent/clarify';

export interface Attachment {
  kind: 'file' | 'image';
  name: string;
  /** For file attachments: the text content. */
  text?: string;
  /** For image attachments: a data: URL. */
  dataUrl?: string;
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
  /** Selected model for utility tasks (titles, commit messages); 'auto' = keyless-preferred. */
  utilityModel: string;
  /** Session toggle: when true, the agent runs commands and applies edits without asking (dangerous commands still confirm). */
  autoApprove: boolean;
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
  | { type: 'sendMessage'; requestId: string; text: string; mode: 'auto' | 'chat' | 'plan' | 'agent' | 'debug' | 'orchestrator'; model: string; reasoningEffort: ReasoningEffort; attachments?: Attachment[] }
  | { type: 'approvePlan'; requestId: string; approved: boolean; steps: string }
  | { type: 'answerClarifying'; requestId: string; answers: string[] }
  | { type: 'renameSession'; title: string }
  | { type: 'vote'; requestId: string; vote: 'up' | 'down' | 'none' }
  | { type: 'cancel'; requestId: string }
  | { type: 'commandApprovalResponse'; id: string; approved: boolean }
  | { type: 'editApprovalResponse'; id: string; approved: boolean }
  | { type: 'requestConfig' }
  | { type: 'setFallbackConfig'; entries: FallbackEntry[] }
  | { type: 'setEndpoint'; platform: Platform; url: string }
  | { type: 'resetEndpoint'; platform: Platform }
  | { type: 'setKey'; platform: Platform }
  | { type: 'attachFromWorkspace' }
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
  | { type: 'setAutoApprove'; enabled: boolean }
  | { type: 'resume'; requestId: string }
  | { type: 'newChat' };

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
}

// Extension -> Webview
export type OutMessage =
  | { type: 'config'; config: ConfigPayload; usageTotals: UsageTotals }
  | { type: 'userEcho'; requestId: string; text: string }
  | { type: 'assistantStart'; requestId: string; platform: string; model: string }
  | { type: 'planProposed'; requestId: string; steps: string }
  | { type: 'commandApproval'; requestId: string; id: string; command: string; cwd?: string }
  | { type: 'editApproval'; requestId: string; id: string; path: string; title: string; kind: 'write' | 'delete' }
  | { type: 'clarifyingQuestions'; requestId: string; questions: ClarifyingQuestion[] }
  | { type: 'sessionTitle'; title: string }
  | { type: 'assistantMessage'; requestId: string; text: string; reasoning?: string; usage?: UsagePayload; platform?: string; model?: string; paused?: boolean }
  | { type: 'usageTotals'; totals: UsageTotals }
  | { type: 'indexProgress'; building: boolean; done: number; total: number; phase: 'scanning' | 'embedding' | 'done' | 'error' }
  | { type: 'checkpoint'; requestId: string; id: string; files: CheckpointFile[] }
  | { type: 'toolStatus'; requestId: string; toolCallId: string; name: string; args: unknown; state: 'running' | 'done' | 'error'; detail?: string }
  | { type: 'changedFiles'; id: string; files: CheckpointFile[] }
  | { type: 'agentStep'; requestId: string; phase: 'thinking' | 'synthesizing' | 'done'; label: string }
  | { type: 'todos'; requestId: string; todos: TodoItem[] }
  | { type: 'failoverNotice'; requestId: string; from: string; reason: string }
  | { type: 'attachmentAdded'; attachment: Attachment }
  | { type: 'mentionResults'; queryId: number; items: MentionItem[] }
  | { type: 'mcpRegistryResults'; queryId: number; items: McpRegistryItem[]; error?: string }
  | { type: 'restore'; messages: TranscriptMessage[] }
  | { type: 'setInput'; text: string }
  | { type: 'toggleSettings' }
  | { type: 'notice'; text: string }
  | { type: 'error'; requestId?: string; message: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'clear' };

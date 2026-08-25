

// ── The simple execution core (2026-08-24 reset) ────────────────────────────────────────
// One streamText() call over the Router, the complete toolset, and ONE neutral transcript.
// The AI SDK owns the model loop (tool-call → result → next step → final text); the Router
// owns model selection and mechanical rotation; the transcript (CoreMessage[]) owns
// continuity — every model sees the actual execution history, dialects normalized by the SDK.
//
// Architectural rule this file enforces on itself: MECHANICAL EXECUTION ONLY.
//   May:   execute tools/models, preserve/prune/condense context, rotate providers, recover
//          from provider failures (exactly ONE continuation), enforce approvals and tool
//          safety, stop at hard execution limits, collect results.
//   Never: judge answer quality, detect "narration", retry on weak-looking output, synthesize
//          a second answer, force tool calls, or decide the model "failed" semantically.
// The judgment tower this replaces (detectors, nudges, retry ladders, planners, judges,
// forced synthesis) lives in git history under the `pre-simple-core` tag.
import { streamText, generateText, wrapLanguageModel, isStepCount, pruneMessages, NoSuchToolError, InvalidToolInputError, type ModelMessage, type ToolSet, type LanguageModel, type UserContent, type AssistantContent, type ToolModelMessage, type ToolContent, type TextPart, type FilePart } from 'ai';
import type { LanguageModelV4ToolCall } from '@ai-sdk/provider';
import * as vscode from 'vscode';
import type { Router } from '../../router/router';
import type { ChatMessage, ChatContentBlock } from '../../shared/types';
import type { WorkReportData } from '../../shared/workReport';
import type { AgentOpts, AgentResult } from '../agent';
import { classifyTaskCore, attachmentKindsFromContent, isPureVisualDescribe, type TaskKind } from '../routing';
import { contentToString } from '../content';
import { buildSimpleSystemPrompt } from '../promptBuilder';
import { recordFindings } from '../sessionFindings';
import { fitMessages } from '../budget';
import { createRouterProvider } from './routerProvider';
import { createTelemetryMiddleware } from './middleware/telemetry';
import { createToolApproval, MUTATING_TOOLS } from './policies/permission';
import { createToolSet } from './tools';
import { compactToolResult, toolCompactionLevel } from './tools/compactResult';
import { getMcpManager } from './tools/mcp/manager';
import { resolveVerifyCommand, runVerifyCommand } from './tools/workspace/verifyCommand';
import { resolveWorkspacePath } from './tools/resolvePath';
import { AnchorStore, stripAnchorBlock, renderTouchedFiles } from './anchors';
import { collapseRepeatedSteps } from './collapseRepeat';
import { TurnWatchdog } from './watchdog';
import { resolveExecutionProfile } from '../executionProfile';
import { diagLog } from '../../util/diag';
import { repairToolArguments, sanitizeToolName } from '../toolArgs';
import type { ClarifyingQuestion } from '../clarify';

/** Runtime scrub for the "Next Steps:" / "I will now…" planning-leak pattern. Even with
 *  a system-prompt instruction telling the model not to narrate its plan in the chat,
 *  free/weak models occasionally emit a "Next Steps:" or "Let me first…" line BEFORE
 *  their first tool call in a turn — the state machine routes that first text-delta
 *  to the chat (since `hadToolCalls` is still false), and the user sees the model
 *  talking to itself in the reply bubble. When the same step also issues a tool call
 *  and the streamed chat text starts with one of these markers, retro-route it to
 *  the reasoning channel and post a retract-draft so the webview drops the in-flight
 *  segment. Match the start of the *trimmed* text only — a model that buries "next
 *  steps" mid-paragraph is just enumerating, not narrating. */
const PLANNING_PREFIX_RE = /^(next\s*steps?:|i\s*(?:will|'ll)\s+now|first,?\s+i\s*(?:will|'ll)|let\s+me\s+(?:first|now|start|check|look|see|search|open|read|run|try)|sure,?\s+(?:let\s+me|i\s*(?:will|'ll))|ok,?\s+(?:let\s+me|i\s*(?:will|'ll))|i'?m\s+going\s+to|i'?m\s+going\s+to\s+(?:now|first)|to\s+(?:start|begin),?\s+i\s*(?:will|'ll))/i;

/** The transcript's neutral shape IS the SDK's ModelMessage — keeping them identical is what
 *  lets the streamText/generateText boundaries below stay cast-free (the compiler, not a
 *  runtime surprise, catches SDK shape drift on upgrade). */
type CoreMessage = ModelMessage;

// ── ChatMessage → CoreMessage conversion (the transcript's neutral shape) ───────────────

/** Converts one TierMux content block to an AI SDK FilePart — used for both `image_url` and
 *  `file` blocks (ImagePart is deprecated in favor of FilePart with mediaType: 'image'). Content
 *  blocks the SDK doesn't need a part for (plain text) are handled by the caller. */
function toFilePart(block: Extract<ChatContentBlock, object>): { type: 'file'; data: string; mediaType: string; filename?: string } | undefined {
  if (block.type === 'image_url' && typeof block.image_url === 'object' && block.image_url) {
    const img = block.image_url as { url?: string; mime?: string; filename?: string };
    if (typeof img.url === 'string') return { type: 'file', data: img.url, mediaType: img.mime || 'image/png', filename: img.filename };
  }
  if (block.type === 'file' && typeof block.file === 'object' && block.file) {
    const f = block.file as { file_data?: string; mime?: string; filename?: string };
    if (typeof f.file_data === 'string') return { type: 'file', data: f.file_data, mediaType: f.mime || 'application/octet-stream', filename: f.filename };
  }
  return undefined;
}

/** Converts a user message's content (string, or a mixed text+attachment block array) into AI
 *  SDK's multi-part user content shape, preserving image/file blocks — flattening to text alone
 *  would silently drop attachments. */
function toUserContent(content: ChatMessage['content']): UserContent {
  if (typeof content === 'string' || content == null) return contentToString(content);
  const parts: Array<TextPart | FilePart> = [];
  for (const block of content) {
    if (typeof block === 'string') { if (block) parts.push({ type: 'text', text: block }); continue; }
    const filePart = toFilePart(block);
    if (filePart) { parts.push(filePart); continue; }
    if (typeof block.text === 'string' && block.text) parts.push({ type: 'text', text: block.text });
  }
  return parts.length ? parts : contentToString(content);
}

/** True only for a genuine cancellation/abort — NOT for provider or validation errors
 *  that happen to coincide with an aborted signal. An abort must never be mistaken for a
 *  provider failure (it must not trigger the mechanical continuation). */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const code = (err as { code?: unknown })?.code;
  return code === 'aborted' || code === 20 /* DOMException.ABORT_ERR */ || /abort/i.test((err as { message?: string })?.message ?? '');
}

function toCoreMessages(messages: ChatMessage[]): CoreMessage[] {
  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) toolNameByCallId.set(tc.id, tc.function.name);

  const mapped = messages.map((m): CoreMessage => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts: AssistantContent = [];
      const text = contentToString(m.content);
      if (text) parts.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave empty */ }
        parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input });
      }
      return { role: 'assistant', content: parts };
    }
    if (m.role === 'tool') {
      const toolName = m.name ?? toolNameByCallId.get(m.tool_call_id ?? '') ?? 'tool';
      return { role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', toolName, output: { type: 'text', value: contentToString(m.content) } }] };
    }
    if (m.role === 'user') {
      return { role: 'user', content: toUserContent(m.content) };
    }
    // Persisted JSON is untrusted — the role union is asserted, not believed.
    return { role: m.role, content: contentToString(m.content) } as CoreMessage;
  });
  return sanitizeCoreMessages(mapped);
}

/** Enforce the AI SDK's history invariant: every assistant `tool-call` part MUST have a
 *  matching `tool-result`, and every `tool` message MUST reference a preceding tool-call.
 *  History persisted from an interrupted/paused/condensed turn can violate this. Repair by
 *  dropping orphaned tool-call parts and lone tool messages so streamText always gets
 *  well-formed input. */
function sanitizeCoreMessages(msgs: CoreMessage[]): CoreMessage[] {
  const idsWithResult = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'tool') continue;
    for (const p of m.content) {
      if (p.type === 'tool-result') idsWithResult.add(p.toolCallId);
    }
  }
  const seenCalls = new Set<string>();
  const out: CoreMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && typeof m.content !== 'string') { // parts form carries tool-calls
      const filtered = m.content.filter((p) => {
        if (p.type !== 'tool-call') return true;
        if (!idsWithResult.has(p.toolCallId)) return false; // orphan — no result anywhere
        seenCalls.add(p.toolCallId);
        return true;
      });
      if (filtered.length === 0) continue; // assistant msg became empty — drop it
      out.push({ role: 'assistant', content: filtered });
      continue;
    }
    if (m.role === 'tool') {
      const filtered = m.content.filter((p) => p.type === 'tool-result' && seenCalls.has(p.toolCallId));
      if (filtered.length === 0) continue; // result for a call we dropped above
      out.push({ role: 'tool', content: filtered });
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Rough token estimate (~4 chars/token) — used only to decide WHEN to prune. */
function roughTokens(messages: CoreMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) for (const p of c) chars += JSON.stringify(p).length;
  }
  return Math.ceil(chars / 4);
}

// ── Tool bookkeeping (pure data — no judgment) ──────────────────────────────────────────

/** Tools whose successful call after a mutation counts as exercising the change. */
const VERIFY_TOOLS = new Set(['runCommand', 'getDiagnostics', 'checkUrl']);
/** Tools whose own execute() self-verifies the write (post-edit diagnostics check). */
const SELF_VERIFYING_TOOLS = new Set(['writeFile', 'createFile', 'editFile']);
/** Tools whose `path` argument names a workspace file the agent genuinely looked at. */
const PATH_ARG_TOOLS = new Set(['readFile', 'writeFile', 'createFile', 'editFile', 'getSymbolGraph', 'getDependencyTree']);

/** The `path`-ish argument of a tool call, if it looks like one. Args arrive as `unknown` from
 *  the stream part (and from a weak model, sometimes as a JSON string). */
function pathArgOf(input: unknown): string | undefined {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  if (!v || typeof v !== 'object') return undefined;
  const p = (v as Record<string, unknown>).path ?? (v as Record<string, unknown>).file;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/** Flatten the per-attempt changedFiles Map into the AgentResult array shape. */
function mapChangedFiles(m: Map<string, 'created' | 'modified' | 'deleted'>): { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined {
  if (!m.size) return undefined;
  return [...m.entries()].map(([path, status]) => ({ path, status }));
}

/** Merge one attempt's changedFiles into another's (mechanical continuation merges both). */
function mergeChangedFiles(a: { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined, b: { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined): { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const m = new Map<string, 'created' | 'modified' | 'deleted'>();
  const rank = { created: 3, deleted: 2, modified: 1 } as const;
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    const prev = m.get(e.path);
    if (!prev || rank[e.status] >= rank[prev]) m.set(e.path, e.status);
  }
  return [...m.entries()].map(([path, status]) => ({ path, status }));
}

/** Tools whose result is worth retaining for late re-anchoring (anchors.ts): they return the
 *  CONTENT of a specific file, keyed by a `path` argument. */
const ANCHOR_TOOLS = new Set(['readFile']);
/** Mutating, path-taking tools whose target is pinned into the anchor store after the write. */
const PIN_ON_MUTATION_TOOLS = new Set(['writeFile', 'createFile', 'editFile']);
/** Ceiling on a pinned file's retained text. */
const PIN_CONTENT_CAP = 12_000;

/** Tool-result pruning policy for `prepareStep`. Read-type results are the bloat and are
 *  evicted aggressively once used; mutating results are a handful of bytes and ARE the turn's
 *  memory of what it already did — never pruned. */
const PRUNE_TOOL_POLICY = [
  {
    type: 'before-last-2-messages' as const,
    tools: ['readFile', 'grep', 'glob', 'listDir', 'explore', 'getSymbolGraph', 'getDependencyTree',
      'getDiagnostics', 'webSearch', 'deepSearch', 'fetchUrl'],
  },
];
const PRUNABLE_TOOLS = new Set(PRUNE_TOOL_POLICY[0].tools);
const STALE_RESULT_MARKER = '[trimmed]';
const MIN_BLANK_CHARS = 400;

/**
 * Replace stale read-tool output with a one-line placeholder, KEEPING the call record — the
 * model still sees "I ran readFile(src/foo.ts) earlier" and can re-run it deliberately, it
 * just stops re-paying the payload every step. Structurally safe: nothing is added or
 * deleted, so a tool-call can never be orphaned from its result.
 */
export function blankStaleToolResults(messages: CoreMessage[]): { messages: CoreMessage[]; blanked: number } {
  const keepFrom = messages.length - 2;
  if (keepFrom <= 0) return { messages, blanked: 0 };
  const pathById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const part of m.content) {
      if (part.type !== 'tool-call') continue;
      const p = pathArgOf(part.input);
      if (p) pathById.set(part.toolCallId, p);
    }
  }
  // runCommand supersession: only the newest result of each command stays in full.
  const cmdById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const part of m.content) {
      if (part.type !== 'tool-call' || part.toolName !== 'runCommand') continue;
      const c = (part.input as { command?: unknown } | undefined)?.command;
      if (typeof c === 'string' && c.trim()) cmdById.set(part.toolCallId, c.trim());
    }
  }
  const lastResultIdxByCmd = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    for (const part of m.content) {
      if (part.type !== 'tool-result' || part.toolName !== 'runCommand') continue;
      const cmd = cmdById.get(part.toolCallId);
      if (cmd) lastResultIdxByCmd.set(cmd, i);
    }
  });

  let blanked = 0;
  const out = messages.map((m, i) => {
    if (i >= keepFrom || m.role !== 'tool') return m;
    let changed = false;
    const content: ToolContent = m.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const output = part.output as { type?: string; value?: unknown } | undefined;
      if (output?.type !== 'text' || typeof output.value !== 'string') return part;
      if (output.value.length <= MIN_BLANK_CHARS || output.value.startsWith(STALE_RESULT_MARKER)) return part;

      if (part.toolName === 'runCommand') {
        const cmd = cmdById.get(part.toolCallId);
        if (!cmd || (lastResultIdxByCmd.get(cmd) ?? -1) <= i) return part;
        changed = true;
        blanked++;
        const trailing = /\n?(\[[^\[\]\n]*\])\s*$/.exec(output.value)?.[1] ?? '';
        return {
          ...part,
          output: {
            type: 'text' as const,
            value: `${STALE_RESULT_MARKER} Superseded earlier run of \`${cmd.slice(0, 80)}\` — a newer run of the same command exists below.${trailing ? ` ${trailing}` : ''}`,
          },
        };
      }

      if (!PRUNABLE_TOOLS.has(part.toolName)) return part;
      changed = true;
      blanked++;
      const path = pathById.get(part.toolCallId);
      const what = `${part.toolName}${path ? `(${path})` : ''}`;
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: `${STALE_RESULT_MARKER} You ran ${what} earlier this turn; its output was trimmed to save context. `
          + 'Run it again only if you actually need the contents — do not redo work you already did.',
        },
      };
    });
    return changed ? ({ ...m, content } as ToolModelMessage) : m;
  });
  return { messages: out, blanked };
}

// ── Tool-call repair (SDK-documented pattern — mechanical, kept as-is) ──────────────────

/** Names weak models invent for tools that DO exist under another name. */
const TOOL_NAME_ALIASES: Record<string, string> = {
  read: 'readFile', readfile: 'readFile', cat: 'readFile', open: 'readFile', view: 'readFile',
  write: 'writeFile', create: 'createFile', edit: 'editFile', patch: 'editFile', replace: 'editFile',
  delete: 'deleteFile', remove: 'deleteFile', rm: 'deleteFile',
  ls: 'listDir', list: 'listDir', listdirectory: 'listDir', dir: 'listDir',
  find: 'glob', search: 'grep', ripgrep: 'grep', rg: 'grep', searchfiles: 'grep',
  bash: 'runCommand', shell: 'runCommand', run: 'runCommand', exec: 'runCommand', terminal: 'runCommand',
  todo: 'todowrite', todos: 'todowrite', todowrite: 'todowrite',
  websearch: 'webSearch', fetch: 'fetchUrl', fetchurl: 'fetchUrl',
  ask: 'question', askuser: 'question',
  diagnostics: 'getDiagnostics', symbols: 'getSymbolGraph', symbolgraph: 'getSymbolGraph',
  dependencies: 'getDependencyTree', dependencytree: 'getDependencyTree',
};

/** Map a model-invented tool name onto a real one from THIS turn's tool set, or undefined. */
function resolveToolName(name: string, tools: Record<string, unknown>): string | undefined {
  if (!name) return undefined;
  if (tools[name]) return name;
  const key = name.toLowerCase().replace(/[_\-\s]/g, '');
  for (const real of Object.keys(tools)) {
    if (real.toLowerCase().replace(/[_\-\s]/g, '') === key) return real;
  }
  const alias = TOOL_NAME_ALIASES[key];
  return alias && tools[alias] ? alias : undefined;
}

/** LLM task-classifier — the regex's smart sibling (the `classifyTaskSmart` the routing.ts
 *  comments have promised). Runs by default on every non-trivial turn, BEFORE routing, so the
 *  model pick reflects what the user actually asked rather than what a regex happened to match.
 *  Model preference (Router.pickClassifierModel): `tiermux.classifierModel` (user-set) first,
 *  then the keyless chain opencode → kilo → ovh. Strictly time-boxed (SMART_CLASSIFY_TIMEOUT_MS)
 *  and fail-safe: timeout, abort, unavailable model, or an unparseable reply all fall back to
 *  the regex kind — a wrong-but-instant answer beats a late one, and the regex already ran. */
const SMART_CLASSIFY_TIMEOUT_MS = 3_000;
const SMART_KINDS = ['trivial', 'chat', 'coding', 'debug', 'vision', 'longContext', 'agent'] as const;
type SmartKind = typeof SMART_KINDS[number];

export async function classifyTaskSmart(
  router: Router,
  text: string,
  attachmentKinds: ReadonlyArray<'file' | 'image' | 'pdf' | 'doc'>,
  regexKind: TaskKind,
  abortSignal?: AbortSignal,
): Promise<TaskKind> {
  if (text.trim().length < 4 && attachmentKinds.length === 0) return regexKind; // too short to be worth a call
  try {
    const classifierModel = await router.pickClassifierModel();
    if (!classifierModel) return regexKind; // no keyless/classifier model enabled — regex only
    const timeout = AbortSignal.timeout(SMART_CLASSIFY_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    const provider = createRouterProvider(router, { taskKind: 'reasoning', pinnedModel: classifierModel });
    const attachments = attachmentKinds.length
      ? `The user attached: ${attachmentKinds.join(', ')}.\n`
      : '';
    const prompt = 'Classify this user request for a coding assistant into exactly ONE task kind.\n'
      + `Kinds: ${SMART_KINDS.join(', ')}\n`
      + '- trivial: greeting/small-talk/thanks\n'
      + '- chat: a question or explanation request about anything\n'
      + '- coding: an explicit request to write/modify code\n'
      + '- debug: something is failing/broken and needs investigating\n'
      + '- vision: the request is about an attached image/pdf itself\n'
      + '- longContext: a very long document/paste is the subject\n'
      + '- agent: an action request (edit files, run commands) that is not clearly code-writing\n\n'
      + `${attachments}User request: ${text.slice(0, 2000)}\n\n`
      + 'Reply with ONLY a JSON object: {"kind": "<one kind>"} — no explanation, no markdown.';
    diagLog('turn.classifySmart', `classifier=${classifierModel} regex=${regexKind}`);
    const { text: reply } = await generateText({ model: provider, prompt, abortSignal: signal });
    const first = reply.indexOf('{');
    const last = reply.lastIndexOf('}');
    if (first === -1 || last <= first) return regexKind;
    const parsed = JSON.parse(reply.slice(first, last + 1)) as { kind?: string };
    if (!parsed.kind || !SMART_KINDS.includes(parsed.kind as SmartKind)) return regexKind;
    const kind = parsed.kind as TaskKind;
    if (kind !== regexKind) diagLog('turn.classifySmart', `regex=${regexKind} → smart=${kind}`);
    return kind;
  } catch {
    return regexKind; // timeout/abort/parse failure — the regex answer stands
  }
}

/** Tier 3 repair: ask a cheap utility model to fix a tool call that deterministic repair
 *  could not. Strictly time-boxed; returns null (drop the call, report as a normal tool
 *  error) when it can't — never fabricates an unrelated call. */
export async function tryModelRepair(
  toolCall: LanguageModelV4ToolCall,
  tools: Record<string, unknown>,
  errorMessage: string,
  schema: unknown,
  router: Router,
  abortSignal?: AbortSignal,
  usageSink?: AgentOpts['usageSink'],
): Promise<LanguageModelV4ToolCall | null> {
  diagLog('turn.repairToolCall.tier3_attempt', `${toolCall.toolName}: ${errorMessage}`);
  const timeout = AbortSignal.timeout(4000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  try {
    const utility = await router.pickUtilityModel();
    const provider = createRouterProvider(router, { taskKind: 'reasoning', pinnedModel: utility, usageSink });
    const toolNames = Object.keys(tools);
    const prompt = schema
      ? `A tool call failed validation.\nTool: ${toolCall.toolName}\nSchema: ${JSON.stringify(schema)}\nArguments: ${toolCall.input}\nError: ${errorMessage}\n\nReply with ONLY the corrected JSON arguments object matching the schema. No explanation, no markdown.`
      : `A tool call named "${toolCall.toolName}" does not exist. Valid tool names: ${toolNames.join(', ')}\nArguments: ${toolCall.input}\nError: ${errorMessage}\n\nReply with ONLY a JSON object of the shape {"toolName": "<correct name from the list>", "input": <corrected arguments object>}. No explanation, no markdown.`;
    const { text } = await generateText({ model: provider, prompt, abortSignal: signal });
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    const candidate = text.slice(first, last + 1);
    if (schema) {
      JSON.parse(candidate); // validate only — throws on garbage
      diagLog('turn.repairToolCall.tier3_success', `invalid-input: ${toolCall.toolName} model-repaired`);
      return { ...toolCall, input: candidate };
    }
    const parsed = JSON.parse(candidate) as { toolName?: string; input?: unknown };
    if (!parsed.toolName || !tools[parsed.toolName] || parsed.input == null) return null;
    diagLog('turn.repairToolCall.tier3_success', `no-such-tool: "${toolCall.toolName}" → "${parsed.toolName}" model-repaired`);
    return { ...toolCall, toolName: parsed.toolName, input: JSON.stringify(parsed.input) };
  } catch {
    return null; // timeout, abort, or genuinely unparseable — surface as a normal tool error
  }
}

/** AI SDK's own inline repair hook for a NATIVE tool call with a bad name/args. Tier 1/2 are
 *  deterministic (repairToolArguments / sanitizeToolName), Tier 3 asks a utility model — the
 *  SDK's own documented repair pattern. */
function createRepairToolCall(
  router: Router,
  abortSignal?: AbortSignal,
  usageSink?: AgentOpts['usageSink'],
): NonNullable<Parameters<typeof streamText>[0]['repairToolCall']> {
  return async ({ toolCall, tools, error, inputSchema }) => {
    if (InvalidToolInputError.isInstance(error)) {
      const schema = await Promise.resolve(inputSchema({ toolName: toolCall.toolName })).catch(() => undefined);
      const repaired = repairToolArguments(toolCall.input, schema as { properties?: Record<string, { type?: string }> } | undefined);
      if (repaired !== toolCall.input) {
        try {
          JSON.parse(repaired);
          diagLog('turn.repairToolCall', `invalid-input: ${toolCall.toolName} repaired`);
          return { ...toolCall, input: repaired };
        } catch { /* fall through to Tier 3 */ }
      }
      return await tryModelRepair(toolCall, tools, error.message, schema, router, abortSignal, usageSink);
    }
    if (NoSuchToolError.isInstance(error)) {
      const fixedName = resolveToolName(sanitizeToolName(toolCall.toolName), tools);
      if (fixedName && fixedName !== toolCall.toolName) {
        diagLog('turn.repairToolCall', `no-such-tool: "${toolCall.toolName}" → "${fixedName}"`);
        return { ...toolCall, toolName: fixedName };
      }
      return await tryModelRepair(toolCall, tools, error.message, undefined, router, abortSignal, usageSink);
    }
    return null;
  };
}

// ── Mechanical continuation for a length-truncated stream ──────────────────────────────

/** Continuation turn for a length-truncated answer (finish_reason: 'length') — a transport
 *  boundary, not a judgment: the model ran out of output tokens mid-answer. Re-invokes the
 *  same model with its own partial in context plus a "resume from the cutoff" instruction,
 *  single-step / no tools, streaming the resume live. */
async function continueAfterTruncation(
  languageModel: LanguageModel,
  system: string,
  opts: AgentOpts,
  workMessages: ChatMessage[],
  onChunk: (t: string) => void,
  onReasoning: (d: string) => void,
): Promise<{ text: string; finishReason?: string }> {
  opts.onStep('synthesizing', 'Continuing answer…');
  try {
    const messages = toCoreMessages([...opts.messages, ...workMessages]);
    messages.push({ role: 'user', content: 'Continue your previous answer exactly where it ended. Do not repeat any text already written — resume from the cutoff and complete the response.' });
    const synth = streamText({
      model: languageModel,
      system,
      messages,
      stopWhen: [isStepCount(1)],
      abortSignal: opts.abortSignal,
    });
    let out = '';
    for await (const part of synth.fullStream) {
      if (part.type === 'text-delta') { const t = part.text; out += t; onChunk(t); }
      else if (part.type === 'reasoning-delta') { onReasoning(part.text); }
      else if (part.type === 'error') { break; }
    }
    let fr: string | undefined;
    try { fr = await synth.finishReason; } catch { /* non-fatal */ }
    return { text: out, finishReason: fr };
  } catch {
    return { text: '', finishReason: undefined }; // best-effort — never mask the partial already shown
  }
}

/** Pruning threshold scaled to the model that will actually serve the turn (85% of the
 *  context window, clamped [12k, 120k] via the ExecutionProfile). A deliberate user-set
 *  `tiermux.agent.pruneAtTokens` always wins and is used literally. */
function adaptivePruneAtTokens(router: Router, taskKind: TaskKind): { atTokens: number; userSet: boolean } {
  const cfg = vscode.workspace.getConfiguration('tiermux.agent');
  const base = cfg.get<number>('pruneAtTokens', 12_000);
  if (base <= 0) return { atTokens: 0, userSet: true }; // explicitly disabled
  const ins = typeof cfg.inspect === 'function' ? cfg.inspect<number>('pruneAtTokens') : undefined;
  const userSet = ins && (ins.globalValue !== undefined || ins.workspaceValue !== undefined
    || ins.workspaceFolderValue !== undefined || ins.globalLanguageValue !== undefined);
  if (userSet || base !== 12_000) return { atTokens: base, userSet: true };
  return { atTokens: resolveExecutionProfile(router.peekTopSelection(taskKind)?.model).pruneTarget, userSet: false };
}

// ── The execution core ──────────────────────────────────────────────────────────────────

/** runAttempt's internal result: AgentResult plus the execution facts the turn layer needs. */
interface AttemptResult extends AgentResult {
  hadToolCalls: boolean;
  hadMutatingToolCall: boolean;
  verifiedAfterMutation: boolean;
  openedFiles: string[];
  /** Tokens the request spends on the system prompt + tool schemas BEFORE any message — the
   *  provider counts it against the window, so the prune cascade and the continuation fitter
   *  must both subtract it from a window-derived message budget. */
  contextOverheadTokens: number;
}

/** Reconstruct the work transcript (tool calls + results) from the SDK's resolved steps into
 *  TierMux ChatMessage form, with per-tool compaction, orphan-settling (no tool-call ever
 *  survives without its result), and repeat collapsing. Shared by the success path and the
 *  catch path's salvage. */
function appendWorkFromSteps(steps: any[], workMessages: ChatMessage[]): void {
  const out: ChatMessage[] = [];
  for (const step of steps) {
    const calls: any[] = step.toolCalls ?? [];
    if (calls.length === 0) continue;
    out.push({
      role: 'assistant',
      content: step.text || null,
      tool_calls: calls.map((tc) => ({ id: tc.toolCallId, type: 'function' as const, function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) } })),
    });
    const settled = new Set<string>();
    const nameById = new Map(calls.map((tc) => [tc.toolCallId as string, tc.toolName as string]));
    const compaction = toolCompactionLevel();
    for (const tr of step.toolResults ?? []) {
      const raw = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? '');
      const content = compactToolResult(nameById.get(tr.toolCallId), raw, compaction);
      out.push({ role: 'tool', content, tool_call_id: tr.toolCallId });
      settled.add(tr.toolCallId);
    }
    // A call that THREW (tool-error part) never appears in toolResults — settle it with the
    // error message so sanitize never deletes the record that the call was attempted.
    for (const part of (step.content ?? []) as Array<{ type?: string; toolCallId?: string; error?: unknown }>) {
      if (part?.type !== 'tool-error' || !part.toolCallId || settled.has(part.toolCallId)) continue;
      const msg = part.error instanceof Error ? part.error.message : String(part.error ?? 'unknown error');
      out.push({ role: 'tool', content: `Tool call failed: ${msg}`, tool_call_id: part.toolCallId });
      settled.add(part.toolCallId);
    }
    // askQuestions (no execute) and approval-denied calls: short placeholder, never orphaned.
    for (const tc of calls) {
      if (settled.has(tc.toolCallId)) continue;
      out.push({
        role: 'tool',
        content: tc.toolName === 'askQuestions' ? 'Clarification requested.' : 'No result was recorded for this tool call.',
        tool_call_id: tc.toolCallId,
      });
      settled.add(tc.toolCallId);
    }
  }
  workMessages.push(...collapseRepeatedSteps(out));
}

async function runAttempt(
  router: Router,
  opts: AgentOpts,
  taskKind: TaskKind,
  prune: { atTokens: number; userSet: boolean },
  maxStepsPerTurn: number,
  providerExclude?: { excludeModels: string[] },
  pureVisualDescribe = false,
): Promise<AttemptResult> {
  // `askQuestions` has no `execute` (human-in-the-loop), so there is no tool-result to feed
  // back — an explicit stop here terminates the turn deterministically when it is called.
  // 'stuck' is set by stuckLoopStop below — a loop-control guardrail stop, which the caller
  // treats as HALT (auto-continuing it would just repeat the waste).
  let stopReason: 'askQuestions' | 'stuck' | undefined;
  let askQuestionsCall: { toolCallId: string; questions: ClarifyingQuestion[] } | undefined;

  let platform: string | undefined;
  let model: string | undefined;
  let runtimeName: string | undefined;

  const provider = createRouterProvider(router, {
    taskKind,
    pinnedModel: opts.pinnedModel,
    sessionId: opts.sessionId,
    usageSink: opts.usageSink,
    onFailover: opts.onFailover,
    onKeyRotated: opts.onKeyRotated,
    onModelSelected: (p, m, rt) => { platform = p; model = m; runtimeName = rt; opts.onModel(p, m, rt); },
    onSelectionRationale: opts.onSelectionRationale,
    ...(providerExclude ?? {}),
  });
  const languageModel = wrapLanguageModel({
    model: provider,
    middleware: createTelemetryMiddleware({ profiler: opts.profiler, traceId: opts.sessionId }),
  });

  // The latest user message is the language-detection input for buildSimpleSystemPrompt.
  // runAttempt is a separately testable seam that doesn't share scope with runTurn's
  // lastUserText; deriving it here keeps the per-attempt system-prompt rebuild (which fires
  // on retry too) language-aware.
  const lastUserForPrompt = [...opts.messages].reverse().find((m) => m.role === 'user');
  const lastUserTextForPrompt = contentToString(lastUserForPrompt?.content ?? '');
  // Prior-turn carry-over: the most recent assistant message whose content is non-empty
  // (skips empty tool-bearers and the synthetic turn-end marker at loop.ts:~1013). This gives
  // the model the referent for short follow-up reformat requests ("in short", "in bangla",
  // "translate", "shorter", etc.) so it doesn't reach for `grep` to "find" the words.
  const lastAssistant = [...opts.messages].reverse().find((m) => m.role === 'assistant' && contentToString(m.content ?? '').trim());
  const priorAssistantText = lastAssistant ? contentToString(lastAssistant.content) : undefined;
  const system = await buildSimpleSystemPrompt(opts.mode, pureVisualDescribe, lastUserTextForPrompt, priorAssistantText);
  // Pure visual-describe turns get NO workspace tools: the attachment is the whole subject, so
  // there is nothing here to read/edit/run. This is what keeps a model that CAN'T actually see
  // the image honest — with no repo tools and no repo profile it can only say "I don't see an
  // image" instead of wandering the workspace and presenting that as the answer.
  // The pre-turn window estimate also drives the essential-toolset cut for small windows
  // (tools/index.ts) — a failover to a different-window model keeps whatever set this turn
  // started with, the same bounded staleness the prune target already accepts.
  const servingWindow = router.peekTopSelection(taskKind)?.model?.contextWindow ?? undefined;
  const tools = pureVisualDescribe ? undefined : createToolSet(opts, getMcpManager(), router, servingWindow);

  // The provider request carries the system prompt and every tool schema IN ADDITION to the
  // messages. For the 22-tool set that is ~6.5k tokens — on the small/medium free-tier windows
  // this extension routes to, a window-fraction message budget that ignores it lets the request
  // overflow BEFORE the prune cascade fires (2026-08-25 live repro: executors "losing context"
  // mid-turn). Measured per attempt because MCP servers can change the tool set between them.
  // A user-pinned pruneAtTokens keeps its literal meaning.
  const contextOverheadTokens = Math.ceil(((tools ? JSON.stringify(tools).length : 0) + system.length) / 4);
  const messagesBudget = prune.atTokens <= 0 ? 0
    : prune.userSet ? prune.atTokens
      : Math.max(2_000, prune.atTokens - contextOverheadTokens);

  // Tool circuit breaker: a tool that keeps THROWING (dead MCP server, broken shell) is
  // dropped from later steps' activeTools so the model physically can't hammer it.
  const toolFailStreak = new Map<string, number>();
  const brokenTools = new Set<string>();
  for (const [name, t] of Object.entries(tools ?? {})) {
    const toolObj = t as { execute?: (input: unknown, ...rest: unknown[]) => Promise<unknown> };
    if (typeof toolObj?.execute !== 'function') continue; // askQuestions & approval-only tools
    const orig = toolObj.execute.bind(toolObj);
    toolObj.execute = async (input: unknown, ...rest: unknown[]) => {
      if (brokenTools.has(name)) {
        return `[TierMux] ${name} was disabled for the rest of this turn after repeated failures. Use a different tool or finish without it.`;
      }
      try {
        const out = await orig(input, ...rest);
        toolFailStreak.set(name, 0);
        return out;
      } catch (err) {
        const streak = (toolFailStreak.get(name) ?? 0) + 1;
        toolFailStreak.set(name, streak);
        if (streak >= 3 && !brokenTools.has(name)) {
          brokenTools.add(name);
          diagLog('turn.toolBreaker', `${name} disabled after ${streak} consecutive failures (last: ${err instanceof Error ? err.message : String(err)})`);
        }
        throw err; // this failure still surfaces normally; only FUTURE calls are blocked
      }
    };
  }

  const askQuestionsStop = ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string }> }> }): boolean => {
    if (!tools?.askQuestions) return false; // not registered this mode — a name match can't be real
    for (const s of steps) {
      if ((s.toolCalls ?? []).some((tc) => tc.toolName === 'askQuestions')) {
        stopReason = 'askQuestions';
        return true;
      }
    }
    return false;
  };

  // Stuck-loop stop: fire when the trailing run of IDENTICAL tool calls (same tool, same
  // arguments, no different call in between) reaches 3. A model re-issuing the exact same
  // call three times running is not making progress — it is a degenerate loop (2026-08-25
  // live repro: ~50 identical grep steps, 280k in / 41.5k out before the step cap noticed).
  // The failure breaker above only sees calls that THROW; this catches the ones that SUCCEED
  // every time. 3, not 2: an intentional double-check never issues the same call three times
  // in a row with nothing between.
  const STUCK_IDENTICAL_CALLS = 3;
  const callSig = (name: string | undefined, input: unknown): string =>
    `${name ?? '?'}::${typeof input === 'string' ? input : JSON.stringify(input ?? {})}`;
  const stuckLoopStop = ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string; input?: unknown }> }> }): boolean => {
    const sigs: string[] = [];
    for (const s of steps) for (const tc of s.toolCalls ?? []) sigs.push(callSig(tc.toolName, tc.input));
    if (sigs.length === 0) return false;
    let run = 0;
    for (let i = sigs.length - 1; i >= 0 && sigs[i] === sigs[sigs.length - 1]; i--) run++;
    if (run < STUCK_IDENTICAL_CALLS) return false;
    stopReason = 'stuck';
    diagLog('turn.stuckLoop', `stopped after ${run} consecutive identical tool call(s) — arguments unchanged, no progress`);
    return true;
  };

  // Step-cap stop with an explicit flag. The previous `finishReason === 'max-steps'` check was
  // dead code on this SDK version: 'max-steps' is not a FinishReason the SDK ever emits (the
  // overall finishReason is the last step's, i.e. 'tool-calls'), so the cap fired invisibly
  // and `paused` was never set. isStepCount(n) checks equality AFTER a step completes, so
  // `>=` with a `> 0` guard preserves the "0 = off" config meaning.
  let stepCapFired = false;
  const stepCapStop = ({ steps }: { steps: unknown[] }): boolean => {
    if (maxStepsPerTurn <= 0 || steps.length < maxStepsPerTurn) return false;
    stepCapFired = true;
    return true;
  };

  let text = '';
  let reasoning = '';
  const workMessages: ChatMessage[] = [];
  let hadToolCalls = false;
  let hadMutatingToolCall = false;
  let verifiedAfterMutation = false;
  const openedFiles: string[] = [];
  const anchors = new AnchorStore();
  let stepIndex = 0;
  const reanchorChars = vscode.workspace.getConfiguration('tiermux.agent').get<number>('reanchorChars', 6_000);
  const changedFilesMap = new Map<string, 'created' | 'modified' | 'deleted'>();
  let streamResult: ReturnType<typeof streamText<ToolSet>> | undefined;
  // Incremental work transcript, collected part-by-part from the live stream. The `steps`
  // promise REJECTS when the stream errors — without this parallel record, a mid-task
  // provider failure would lose the transcript of work that already ran, and the mechanical
  // continuation would hand the replacement model nothing but the original request.
  const streamWork: ChatMessage[] = [];
  let stepAssistantIdx = -1;
  const settledCallIds = new Set<string>();
  const flushStreamWork = (): void => {
    for (const m of streamWork) {
      if (m.role !== 'assistant' || !m.tool_calls) continue;
      for (const tc of m.tool_calls) {
        if (settledCallIds.has(tc.id)) continue;
        settledCallIds.add(tc.id);
        streamWork.push({ role: 'tool', content: tc.function.name === 'askQuestions' ? 'Clarification requested.' : 'No result was recorded for this tool call.', tool_call_id: tc.id });
      }
    }
  };

  try {
    diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · streamText starting`);
    streamResult = streamText({
      model: languageModel,
      system,
      messages: toCoreMessages(opts.messages),
      tools,
      toolApproval: createToolApproval(opts),
      repairToolCall: createRepairToolCall(router, opts.abortSignal, opts.usageSink),
      // Hard execution limits only: the step cap is a resumable pause (stepCapFired →
      // paused:true); a stuck loop and askQuestions are terminal states.
      stopWhen: [stepCapStop, askQuestionsStop, stuckLoopStop],
      abortSignal: opts.abortSignal,
      // Per-step context compression (AI SDK native): blank stale read payloads, keep call
      // records, then re-anchor the files still under discussion. Mechanical eviction, not
      // judgment — it protects small context windows.
      prepareStep: ({ messages }: { messages: ModelMessage[]; steps: Array<{ usage?: { totalTokens?: number } }> }) => {
        const out: { messages?: ModelMessage[]; activeTools?: string[] } = {};
        if (messagesBudget > 0) {
          const before = roughTokens(messages);
          if (before >= messagesBudget) {
            const { messages: blankedMsgs, blanked } = blankStaleToolResults(messages);
            let pruned = pruneMessages({
              messages: blankedMsgs,
              reasoning: 'before-last-message',
              emptyMessages: 'remove',
            });
            if (roughTokens(pruned) >= messagesBudget) {
              pruned = pruneMessages({
                messages: pruned,
                reasoning: 'before-last-message',
                toolCalls: PRUNE_TOOL_POLICY,
                emptyMessages: 'remove',
              });
              diagLog('turn.prune', `still ~${roughTokens(pruned)}tok after blanking ${blanked} result(s) — fell back to eviction`);
            }
            diagLog('turn.prune', `~${before}tok ≥ ${messagesBudget} → blanked ${blanked}, ${messages.length}→${pruned.length} msgs (~${roughTokens(pruned)}tok)`);
            out.messages = pruned;
            // Late re-anchoring: put a bounded copy of the evicted files back, plus a
            // paths-only manifest, so the model is not answering about code it can no longer see.
            const digest = anchors.digest(reanchorChars);
            const manifest = renderTouchedFiles(openedFiles, changedFilesMap);
            if (digest || manifest) {
              const base = stripAnchorBlock(out.messages);
              const blocks = [digest, manifest].filter(Boolean)
                .map((content) => ({ role: 'user' as const, content }));
              out.messages = [...base, ...blocks];
              diagLog('turn.reanchor', `re-showed ${anchors.size} read file(s), ~${digest.length} chars, + ${manifest ? 'manifest' : 'no manifest'}, after prune`);
            }
          }
        }
        if (tools && brokenTools.size > 0 && !out.activeTools) {
          out.activeTools = Object.keys(tools).filter((name) => !brokenTools.has(name));
        }
        return out;
      },
      onStart: () => opts.onStep('thinking', 'Thinking…'),
      onStepStart: () => opts.onStep('thinking', 'Thinking…'),
    });

    // ── Two-buffer state machine (speculative draft vs canonical reply) ──────────────────
    // Text the model emits in a step that ALSO issues a tool call ("Let me search…") is
    // provisional narration: streamed live as a draft, routed to reasoning at finish-step,
    // never committed as the reply. Only a pure-text step's text is the answer.
    type Phase = 'idle' | 'text' | 'planning' | 'waiting_final' | 'final';
    let phase: Phase = 'idle';
    let finalBuffer = '';
    // cumulative chat text: the union of every step's streamed prose that reached the
    // webview (text-delta routed to opts.onChunk). Kept across steps so the canonical
    // reply text always matches what the user saw streaming live. Without this, a
    // model that ends with a tool-bearing step or a multi-step stream would have a
    // canonical `text` (from the LAST pure-text step) that is shorter — or empty —
    // compared to the live draft, and the assistantMessage handler would wipe the
    // visible draft to render that smaller/empty string, producing the "tokens
    // consumed, no bubble" symptom.
    let cumulativeChatText = '';
    let stepText = '';
    let stepChatText = '';
    let stepHasTool = false;
    let streamedThisStep = false;
    let streamErrored = false;
    let streamErrorMessage = '';

    for await (const part of streamResult.fullStream) {
      if (part.type === 'start-step') {
        stepIndex++;
        stepText = ''; stepChatText = ''; stepHasTool = false; streamedThisStep = false;
        stepAssistantIdx = -1;
        // A new step after one that issued tool calls streams its ANSWER, not more planning
        // narration — without this reset 'planning' leaked across the step boundary and the
        // whole next step's reply was misrouted to the reasoning channel (live chat showed
        // nothing while the answer hid inside the collapsed Thinking block).
        if (phase === 'planning') phase = 'waiting_final';
      } else if (part.type === 'finish-step') {
        if (stepHasTool) {
          if (stepChatText.trim()) {
            // Narration that streamed to the chat bubble as a draft — route to thinking.
            // The runtime scrub (PLANNING_PREFIX_RE) also catches the "Next Steps:" /
            // "I will now…" pattern even when the model emits it in a tool-bearing step
            // (state machine alone misses this because the first text-delta of a turn with
            // a later tool call is still routed to chat). The retract-draft message is
            // posted so the webview can drop the in-flight chat segment.
            const isPlanning = PLANNING_PREFIX_RE.test(stepChatText.trim());
            reasoning += stepChatText;
            opts.onReasoning(stepChatText);
            if (isPlanning && streamedThisStep) opts.onRetractDraft?.();
            // Don't fold planning narration into the cumulative chat text — it never
            // belonged in the user-visible reply.
            if (!isPlanning && streamedThisStep) {
              cumulativeChatText += stepChatText;
            }
          }
        } else if (stepText.trim()) {
          finalBuffer = stepText;
          phase = hadToolCalls ? 'final' : 'text';
          // Commit the per-step chat slice to the running cumulative so assistantMessage can
          // reconcile to the full visible draft, not the LAST pure-text step alone.
          if (streamedThisStep) cumulativeChatText += stepChatText;
        }
      } else if (part.type === 'text-delta') {
        const t = part.text;
        stepText += t;
        if (phase === 'waiting_final' || phase === 'final' || phase === 'text' || (phase === 'idle' && !hadToolCalls)) {
          streamedThisStep = true;
          stepChatText += t;
          opts.onChunk(t);
        } else {
          reasoning += t;
          opts.onReasoning(t);
        }
        if (phase === 'idle') phase = 'text';
        else if (phase === 'waiting_final') phase = 'final';
      } else if (part.type === 'reasoning-delta') {
        const d = part.text; reasoning += d; opts.onReasoning(d);
      } else if (part.type === 'tool-call') {
        hadToolCalls = true; stepHasTool = true; phase = 'planning';
        if (MUTATING_TOOLS.has(part.toolName)) { hadMutatingToolCall = true; verifiedAfterMutation = false; }
        else if (hadMutatingToolCall && VERIFY_TOOLS.has(part.toolName)) verifiedAfterMutation = true;
        if (PATH_ARG_TOOLS.has(part.toolName)) {
          const p = pathArgOf(part.input);
          if (p) openedFiles.push(p);
        }
        if (part.toolName === 'createFile') {
          const p = pathArgOf(part.input); if (p) changedFilesMap.set(p, 'created');
        } else if (part.toolName === 'writeFile' || part.toolName === 'editFile') {
          const p = pathArgOf(part.input); if (p && changedFilesMap.get(p) !== 'created') changedFilesMap.set(p, 'modified');
        } else if (part.toolName === 'deleteFile') {
          const p = pathArgOf(part.input); if (p) changedFilesMap.set(p, 'deleted');
        }
        if (streamedThisStep) opts.onRetractDraft?.();
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'running' });
        if (stepAssistantIdx === -1) {
          streamWork.push({ role: 'assistant', content: null, tool_calls: [] });
          stepAssistantIdx = streamWork.length - 1;
        }
        streamWork[stepAssistantIdx].tool_calls!.push({ id: part.toolCallId, type: 'function', function: { name: part.toolName, arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}) } });
        // askQuestions has no execute — capture its questions here; the questions ARE the
        // response, and askQuestionsStop ends the turn on this call.
        if (part.toolName === 'askQuestions' && tools?.askQuestions) {
          const raw = (part.input as { questions?: Array<Partial<ClarifyingQuestion>> } | undefined)?.questions;
          if (raw && raw.length) {
            const q: ClarifyingQuestion[] = raw
              .filter((x): x is Partial<ClarifyingQuestion> & { text: string } => !!x.text)
              .map((x) => ({ text: x.text, label: x.label, options: x.options ?? [], ...(x.multi ? { multi: true } : {}) }));
            if (q.length) {
              askQuestionsCall = { toolCallId: part.toolCallId, questions: q };
              stopReason = 'askQuestions';
              opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'done', detail: 'Waiting for the user to answer.' });
            }
          }
        }
      } else if (part.type === 'tool-result') {
        phase = 'waiting_final';
        const detail = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
        if (reanchorChars > 0 && ANCHOR_TOOLS.has(part.toolName) && typeof detail === 'string') {
          const p = pathArgOf(part.input);
          if (p) anchors.record(p, detail, stepIndex);
        }
        // Pin a just-edited file with its POST-edit content (the working set outranks reads).
        if (reanchorChars > 0 && PIN_ON_MUTATION_TOOLS.has(part.toolName)) {
          const p = pathArgOf(part.input);
          if (p) {
            try {
              const bytes = await vscode.workspace.fs.readFile(resolveWorkspacePath(p));
              anchors.pin(p, new TextDecoder().decode(bytes).slice(0, PIN_CONTENT_CAP), stepIndex);
            } catch { /* deleted, binary, or outside the workspace — nothing to pin */ }
          }
        }
        if (SELF_VERIFYING_TOOLS.has(part.toolName) && hadMutatingToolCall) verifiedAfterMutation = true;
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'done', detail });
        settledCallIds.add(part.toolCallId);
        streamWork.push({ role: 'tool', content: compactToolResult(part.toolName, detail, toolCompactionLevel()), tool_call_id: part.toolCallId });
      } else if (part.type === 'tool-error') {
        phase = 'waiting_final';
        const detail = part.error instanceof Error ? part.error.message : String(part.error ?? 'tool error');
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'error', detail });
        settledCallIds.add(part.toolCallId);
        streamWork.push({ role: 'tool', content: `Tool call failed: ${detail}`, tool_call_id: part.toolCallId });
      } else if (part.type === 'error') {
        streamErrored = true;
        streamErrorMessage = part.error instanceof Error ? part.error.message : String(part.error ?? '');
        opts.onError(streamErrorMessage);
      }
    }

    // The canonical reply is the LAST pure-text step's text (the loop's prior behavior), but
    // for multi-step streams where the user already saw earlier steps' prose live, the
    // cumulative chat text is the truthful answer — the assistantMessage handler otherwise
    // wipes the visible draft and renders a much shorter (or empty) finalBuffer, producing
    // the "tokens consumed, no bubble" symptom. Prefer cumulative when it has content the
    // finalBuffer dropped; otherwise fall back to the last pure-text step.
    const cum = cumulativeChatText.trim();
    const fin = finalBuffer.trim();
    text = cum && cum !== fin ? cum : (fin || cum);

    let finishReason: string | undefined;
    try { finishReason = await streamResult.finishReason; } catch { /* ignore — non-fatal */ }
    // The step cap fired via stopWhen (stepCapFired) — a resumable pause. A stuck-loop stop is
    // NOT resumable: continuing it would just resume the identical-call loop.
    const paused = stepCapFired && !stopReason;

    try {
      const steps: any[] = (await streamResult.steps) ?? [];
      appendWorkFromSteps(steps, workMessages);
    } catch {
      // The steps promise rejects when the stream errored mid-step — the incremental stream
      // transcript below is the record of what actually ran.
    }
    if (!workMessages.length && streamWork.length) {
      flushStreamWork();
      workMessages.push(...collapseRepeatedSteps(streamWork));
    }
    if (text.trim()) workMessages.push({ role: 'assistant', content: text });

    // Turn-boundary closer: a persisted transcript that ends on raw tool results makes the
    // NEXT user message read like one more query appended to the tool stream (2026-08-25
    // live repro: the follow-up "in short bangla" was answered as a grep for "short, bangla").
    // An explicit terminal marker tells the next model that the turn ENDED and what follows
    // is a new instruction. askQuestions turns are excluded — there the next user message is
    // the ANSWER to the questions, not a new instruction.
    if (!askQuestionsCall) {
      const lastWork = workMessages[workMessages.length - 1];
      if (lastWork && (lastWork.role === 'tool' || (lastWork.role === 'assistant' && lastWork.tool_calls?.length))) {
        workMessages.push({
          role: 'assistant',
          content: stopReason === 'stuck'
            ? '[Turn stopped: the same tool call was repeating without making progress. Awaiting a new instruction from the user.]'
            : paused
              ? '[Turn paused at the step limit before a final answer was produced. Awaiting a new instruction from the user.]'
              : '[Turn ended without a final text answer. Awaiting a new instruction from the user.]',
        });
      }
    }

    // Length-truncation continuation (mechanical: finish_reason 'length' is a transport
    // boundary). Stitch continuations onto the partial so the user sees the full answer.
    if (finishReason === 'length' && !paused && text.trim() && !opts.abortSignal?.aborted) {
      let guard = 0;
      while (finishReason === 'length' && guard < 4 && !opts.abortSignal?.aborted) {
        guard++;
        const more = await continueAfterTruncation(
          languageModel, system, opts, workMessages,
          (t) => { text += t; opts.onChunk(t); },
          (d) => { reasoning += d; opts.onReasoning(d); },
        );
        if (!more.text.trim()) break;
        const last = workMessages[workMessages.length - 1];
        if (last && last.role === 'assistant') last.content = (typeof last.content === 'string' ? last.content : '') + more.text;
        finishReason = more.finishReason;
      }
      if (finishReason === 'length' && guard >= 4 && text.trim() && !/(truncated|cut off|length limit)/i.test(text)) {
        text = `${text.trim()}\n\n_⚠ Still truncated after several continuations — say "continue" to resume._`;
      }
    }

    // Last-resort non-empty guarantee (never a blank turn). Skipped when paused (resumable
    // cutoff — the Continue button is the response), when the real error already surfaced via
    // onError (the host's `failed` branch renders it), and for askQuestions turns (the
    // questions card IS the response). A stuck stop gets its own honest message — the generic
    // "couldn't produce a final answer" would hide why the turn really ended.
    //
    // Reasoning-only turns are a real, observed case: thinking-heavy models (minimax-m2, gpt-oss,
    // qwen3-thinking) can burn a 1:1 reasoning:prose token ratio and exit with 0 output tokens
    // — the model said "I thought about it" but never produced an answer. The fallback must
    // cover that exact case (had reasoning, no final prose, no pause, no error, no questions).
    const sawReasoning = reasoning.trim().length > 0;
    if (!text.trim() && !paused && !streamErrored && !askQuestionsCall) {
      text = stopReason === 'stuck'
        ? 'I stopped because the same tool call kept repeating with identical arguments and made no progress. Try rephrasing the request, or switch to a stronger model.'
        : sawReasoning
          ? 'I thought through this but didn\'t produce a final answer — the model used its budget on reasoning and exited before writing a reply. Try rephrasing the request, or switch to a model that balances reasoning with output.'
          : hadToolCalls
            ? 'I looked into this and ran some tools, but couldn\'t produce a final answer. Try rephrasing the request, or switch to a stronger model.'
            : 'I wasn\'t able to produce a response. Try rephrasing the request, or switch to a stronger model.';
    }

    return {
      text,
      reasoning: reasoning.trim(),
      platform,
      model,
      runtimeName,
      paused,
      workMessages,
      stopReason,
      askQuestions: askQuestionsCall?.questions,
      hadToolCalls,
      hadMutatingToolCall,
      verifiedAfterMutation,
      openedFiles,
      contextOverheadTokens,
      failed: streamErrored && !text.trim(),
      errorMessage: streamErrored ? streamErrorMessage : undefined,
      changedFiles: mapChangedFiles(changedFilesMap),
    };
  } catch (err) {
    diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · CAUGHT aborted=${!!opts.abortSignal?.aborted} isAbort=${isAbortError(err)} err=${err instanceof Error ? err.message : String(err)}`);
    // An abort is a clean stop, never a provider failure. Everything else is genuine and
    // surfaces to the user.
    const genuineFailure = !(opts.abortSignal?.aborted && isAbortError(err));
    const errMsg = err instanceof Error ? err.message : String(err);
    if (genuineFailure) {
      opts.onError(errMsg);
      // Best-effort salvage: the incremental stream transcript survives the throw; the steps
      // promise is still worth one attempt (a post-loop rejection is not guaranteed).
      try {
        const salvagedSteps: any[] = (await streamResult?.steps) ?? [];
        appendWorkFromSteps(salvagedSteps, workMessages);
      } catch { /* steps rejected — the stream transcript below is the record */ }
      if (!workMessages.length && streamWork.length) {
        flushStreamWork();
        workMessages.push(...collapseRepeatedSteps(streamWork));
      }
    }
    return {
      text, reasoning: reasoning.trim(), platform, model, runtimeName, paused: false, workMessages,
      hadToolCalls, hadMutatingToolCall, verifiedAfterMutation, openedFiles, contextOverheadTokens,
      failed: genuineFailure && !text.trim(), errorMessage: genuineFailure ? errMsg : undefined,
      changedFiles: mapChangedFiles(changedFilesMap),
    };
  }
}

// ── The turn ────────────────────────────────────────────────────────────────────────────

/** The verify-fix continuation message: scoped to the failing command's own output so the
 *  model fixes the REMAINING failures in place instead of redoing already-completed work
 *  (the "same work again and again" repro from the 2026-08-25 report). */
function verifyFixMessage(cmd: string, output: string, round: number, maxRounds: number): string {
  return [
    `[Verify fix — round ${round} of ${maxRounds}]`,
    `The project's verify command \`${cmd}\` still FAILS after your changes:`,
    '',
    '```',
    output.slice(-3000),
    '```',
    '',
    'Fix ONLY these failures. Your earlier work is already saved on disk — do NOT redo completed',
    'steps, re-create files that already exist, or restart the task. Make the minimal edits that',
    'make the command pass, then run it yourself to confirm.',
  ].join('\n');
}

export async function runTurn(router: Router, opts: AgentOpts): Promise<AgentResult> {
  // Hard per-turn STEP ceiling (0 = off via config; default 50). A cap hit is a
  // resumable pause, not a terminal stop.
  const maxStepsPerTurn = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxStepsPerTurn', 50);

  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const lastUserText = contentToString(lastUser?.content ?? '');
  const attachmentKinds = lastUser ? attachmentKindsFromContent(lastUser.content) : [];
  let taskKind = opts.mode === 'plan'
    ? ('plan' as TaskKind)
    : classifyTaskCore(lastUserText, { attachmentKinds, attachments: attachmentKinds.length, mentions: opts.mentionCount }).kind;
  // Smart classify by default (plan mode's kind is structural, trivial turns aren't worth a call):
  // the LLM classifier re-decides the regex's answer; any failure keeps the regex kind.
  if (opts.mode !== 'plan' && taskKind !== 'trivial' && !opts.abortSignal?.aborted) {
    taskKind = await classifyTaskSmart(router, lastUserText, attachmentKinds, taskKind, opts.abortSignal);
  }
  const prune = adaptivePruneAtTokens(router, taskKind);

  // ── Telemetry + watchdog wrapping (protocol events stamp activity; quiet turns warn) ──
  const userOnTodos = opts.onTodos;
  const userOnChunk = opts.onChunk;
  const userOnTool = opts.onTool;
  const userOnReasoning = opts.onReasoning;
  const userOnStep = opts.onStep;
  const userOnModel = opts.onModel;
  const userOnKeyRotated = opts.onKeyRotated;
  const userOnSelectionRationale = opts.onSelectionRationale;
  const userOnFailover = opts.onFailover;
  const watchdog = new TurnWatchdog(
    {
      onWarning: (info) => opts.onWatchdogWarning?.(info),
      onActionable: (info) => opts.onWatchdogActionable?.(info),
      onDismissed: () => opts.onWatchdogDismissed?.(),
    },
    () => !!opts.abortSignal?.aborted,
  );
  const toolTally = new Map<string, number>();
  const turnStartMs = Date.now();
  const turnUsage = {
    input: 0,
    output: 0,
    lastModel: 'unknown',
    lastContext: undefined as undefined | { contextTokens: number; contextWindow: number; percent: number },
  };
  const usageSink: NonNullable<AgentOpts['usageSink']> = (info) => {
    turnUsage.input += info.inputTokens;
    turnUsage.output += info.outputTokens;
    if (info.model) turnUsage.lastModel = info.model;
    if (info.contextWindow && info.contextWindow > 0) {
      turnUsage.lastContext = {
        contextTokens: info.contextTokens,
        contextWindow: info.contextWindow,
        percent: Math.min(100, Math.floor((info.contextTokens / info.contextWindow) * 100)),
      };
    }
  };
  let failoverCount = 0;
  let reasoningBlocks = 0;
  let inReasoning = false;
  opts = {
    ...opts,
    usageSink,
    onTodos: (t) => userOnTodos(t),
    onChunk: (t) => { inReasoning = false; watchdog.activity('streaming text'); watchdog.markPartialOutput(); userOnChunk(t); },
    onTool: (e) => {
      inReasoning = false;
      if (e.state === 'running') toolTally.set(e.name, (toolTally.get(e.name) ?? 0) + 1);
      watchdog.noteTool(e.state === 'running');
      watchdog.activity(`${e.name} ${e.state}`);
      userOnTool(e);
    },
    onReasoning: (t) => {
      if (!inReasoning) { reasoningBlocks++; inReasoning = true; }
      watchdog.activity('reasoning'); userOnReasoning(t);
    },
    onStep: (p, label) => { watchdog.activity(label); userOnStep(p, label); },
    onModel: (p, m, rt) => { watchdog.activity(`routing → ${p}/${m}`); userOnModel(p, m, rt); },
    onKeyRotated: (info) => { watchdog.activity(`key rotated → ${info.keyIndex}/${info.keyTotal}`); userOnKeyRotated?.(info); },
    onSelectionRationale: (info) => { watchdog.activity(info.picked ? `selected ${info.picked}` : 'model selection'); userOnSelectionRationale?.(info); },
    onFailover: (from, reason) => { failoverCount++; watchdog.activity(`failover from ${from} (${reason})`); userOnFailover?.(from, reason); },
  };

  // Pure "describe this image" turns (isPureVisualDescribe): the attachment is the whole
  // subject, so runAttempt builds their system prompt WITHOUT the repo profile — no Laravel
  // facts to fuse into a trip-screenshot answer (see the guard's comment in promptBuilder).
  const pureVisual = isPureVisualDescribe(lastUserText, attachmentKinds.some((k) => k === 'image' || k === 'pdf'));

  try {
    let final = await runAttempt(router, opts, taskKind, prune, maxStepsPerTurn, undefined, pureVisual);

    // ── Mechanical provider-failure continuation (exactly ONE) ──────────────────────────
    // Fires only when provider EXECUTION failed before the task completed (`failed` — a real
    // error surfaced via onError/throw, never an abort). The replacement model receives the
    // full accumulated transcript — user request, prior assistant output, tool calls and
    // results — fitted to its context window. That transcript handoff IS cross-model
    // continuity. One continuation, whatever it yields, then stop.
    if (final.failed && !opts.abortSignal?.aborted && final.platform && final.model) {
      const excludeKey = `${final.platform}::${final.model}`;
      diagLog('turn.continue', `provider failure from ${excludeKey} — one mechanical continuation with the accumulated transcript`);
      const continuationMessages = [...opts.messages, ...(final.workMessages ?? [])];
      const window = router.peekTopSelection(taskKind)?.model?.contextWindow ?? 32_768;
      // The continuation request carries the same system+tools overhead as the failed attempt —
      // a window-fraction budget that ignores it reproduces the overflow that just failed the
      // attempt, on the very call meant to recover from it.
      const fitBudget = Math.max(2_000, Math.floor(window * 0.8) - final.contextOverheadTokens);
      const fitted = fitMessages(continuationMessages, fitBudget);
      if (fitted.trimmed) diagLog('turn.continue', `transcript fitted to ~${fitBudget} input tokens for the replacement model`);
      const excludeModels = [...(opts.excludeModels ?? []), excludeKey];
      const continued = await runAttempt(router, { ...opts, messages: fitted.messages, excludeModels }, taskKind, prune, maxStepsPerTurn, { excludeModels }, pureVisual);
      final = {
        ...continued,
        changedFiles: mergeChangedFiles(final.changedFiles, continued.changedFiles),
      };
    }

    // ── Command verify + bounded fix rounds ────────────────────────────────────────────
    // After a mutating turn settles, run the project's verify command. A non-zero exit is
    // NOT handed to the user to re-check — the agent owns the recheck (live repro, 2026-08-25
    // user report: a Laravel turn ended on "Shall I proceed…?" while `php artisan test` failed
    // and the ResultCard offered the user a manual "Re-run checks" button). The failure output
    // is fed back for bounded same-routing fix rounds (`tiermux.agent.verifyFixRounds`, 0 =
    // off). This is mechanical recovery, not answer judgment — the trigger is the command's
    // EXIT CODE, the same signal planRunner's verify-failure retry keys on; no model
    // escalation, no quality decisions (see docs/SIMPLE_CORE_RESET_2026-08-24.md, invariant 8).
    const verifyCmd = resolveVerifyCommand();
    const maxFixRounds = vscode.workspace.getConfiguration('tiermux.agent').get<number>('verifyFixRounds', 2);
    let verifyOutcome: 'passed' | 'failed' | 'unverified' | undefined;
    let fixRounds = 0;
    if (final.hadMutatingToolCall && !opts.abortSignal?.aborted && verifyCmd) {
      opts.onStep('verifying', `Verifying with ${verifyCmd}…`);
      let run = await runVerifyCommand(verifyCmd);
      while (run.ok === false && fixRounds < maxFixRounds && !opts.abortSignal?.aborted) {
        fixRounds += 1;
        opts.onStep('verifying', `Verify failed — fix round ${fixRounds}/${maxFixRounds}…`);
        const fixPrompt = verifyFixMessage(verifyCmd, run.output, fixRounds, maxFixRounds);
        const fixMessages: ChatMessage[] = [...(final.workMessages ?? []), { role: 'user', content: fixPrompt }];
        const fixed = await runAttempt(
          router,
          { ...opts, messages: [...opts.messages, ...fixMessages] },
          taskKind, prune, maxStepsPerTurn,
        );
        // The fix round's transcript is part of the SAME turn: merged so persistence keeps one
        // continuous record and changedFiles stay whole across rounds. The last round's text is
        // the turn's answer — it reflects the state the final verify actually measured.
        final = {
          ...fixed,
          changedFiles: mergeChangedFiles(final.changedFiles, fixed.changedFiles),
          workMessages: [...fixMessages, ...(fixed.workMessages ?? [])],
          verifiedAfterMutation: final.verifiedAfterMutation || fixed.verifiedAfterMutation,
        };
        // A provider failure, a clarification request, or a stuck loop inside the fix round is
        // a stop state, not a signal to loop — re-verifying can't change either.
        if (fixed.failed || fixed.stopReason === 'askQuestions' || fixed.stopReason === 'stuck') break;
        run = await runVerifyCommand(verifyCmd);
      }
      if (run.ok === true) {
        final = { ...final, verifiedAfterMutation: true };
        verifyOutcome = 'passed';
      } else if (run.ok === false) {
        verifyOutcome = 'failed';
      }
    } else if (final.hadMutatingToolCall) {
      verifyOutcome = 'unverified';
    }

    // ── Deterministic end-of-turn Work Report ───────────────────────────────────────────
    let workReport: WorkReportData | undefined;
    if ((final.hadMutatingToolCall || verifyOutcome) && !opts.abortSignal?.aborted) {
      const toolTallyList = [...toolTally.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
      const reportOutcome = verifyOutcome === 'passed' ? 'verified' as const
        : verifyOutcome === 'failed' ? 'failed' as const
        : final.verifiedAfterMutation && !final.stopReason ? 'changes-only' as const
        : 'unverified' as const;
      workReport = {
        version: 1,
        verifyOutcome: reportOutcome,
        verifyAvailable: !!verifyCmd,
        verifyCmd: verifyOutcome === 'passed' || verifyOutcome === 'failed' ? verifyCmd : undefined,
        fixRounds,
        changedFiles: (final.changedFiles ?? []).map((f) => ({
          path: f.path,
          status: f.status === 'created' ? 'A' as const : f.status === 'modified' ? 'M' as const : 'D' as const,
        })),
        toolTally: toolTallyList,
        stopReason: final.stopReason ?? '',
        telemetry: {
          model: turnUsage.lastModel,
          taskKind,
          inputTokens: turnUsage.input,
          outputTokens: turnUsage.output,
          toolCalls: toolTallyList.reduce((s, t) => s + t.count, 0),
          thoughts: reasoningBlocks,
          failovers: failoverCount,
          elapsedMs: Date.now() - turnStartMs,
        },
        context: turnUsage.lastContext,
      };
    }

    // Carry what this turn established into the next one (mechanical memory).
    recordFindings(opts.sessionId, final.openedFiles, final.text);

    return {
      text: final.text,
      reasoning: final.reasoning || undefined,
      platform: final.platform,
      model: final.model,
      runtimeName: final.runtimeName,
      taskKind,
      paused: final.paused,
      stopReason: final.stopReason,
      askQuestions: final.askQuestions,
      workMessages: final.workMessages?.length ? final.workMessages : undefined,
      changedFiles: final.changedFiles,
      verifyOutcome,
      failed: final.failed && !final.text.trim(),
      errorMessage: final.errorMessage,
      workReport,
    };
  } finally {
    watchdog.stop();
  }
}


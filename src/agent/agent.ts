// Agent loop: drives Chat / Plan / Agent modes over the router + tools.
import * as vscode from 'vscode';
import type { ChatContent, ChatMessage, ChatToolCall, ReasoningEffort, TodoItem } from '../shared/types';
import type { Router } from '../router/router';
import type { WorkspaceTools, ToolEvent } from './tools';
import type { McpManager } from '../mcp/mcpManager';
import type { CodebaseIndex } from '../index/codebaseIndex';
import { contentToString } from './content';
import { sanitizeToolName, repairBrokenJson } from './toolArgs';
import { TOOL_SPECS, CODEBASE_SEARCH_SPEC, GLOB_SPEC, GREP_SPEC, ASK_USER_SPEC, SKILL_SPEC, WEB_TOOL_SPECS, GRAPH_TOOLS_SPEC, READ_IMAGE_SPEC, READ_DOCUMENT_SPEC, CORE_TOOL_SPECS, THINK_SPEC } from './toolSpecs';
import { AGENT_SYSTEM, CHAT_SYSTEM, PLAN_SYSTEM, RESPONSIBILITY_RULES } from './prompts';
import { loadProjectRules } from '../context/projectRules';
import { loadUserMemory, inferStyleFromEdits, upsertLearnedSection } from '../context/userMemory';
import { loadProjectGrounding } from '../context/projectGrounding';
import { buildAmbientContext } from '../context/ambient';
import { modeToKind, classifyTask, classifyInformationNeed, informationSourceHint, isCodebaseQuestion, type TaskKind } from './routing';
import { classifyInformationRoute } from '../router/informationRouter';
import { parseTextToolCalls, textToolProtocolPrompt } from './textToolProtocol';
import type { RunContext } from './runContext';
import { unmarkEditing } from './editLock';
import type { RouteOptions } from '../router/router';
import { buildStructuralGraph, loadStructuralGraph, graphSummary, type StructuralGraph } from '../context/structuralGraph';
import { lookupBundle, saveBundle, formatBundle, compressGrepResults } from '../context/bundleCache';
import { getOrBuildSymbolIndex, searchSymbols, formatSymbolHits } from '../context/symbolIndex';
import { lookupInvertedIndex, formatIndexHits, indexIsFresh } from '../context/invertedIndex';
import { pickTemplate, getTemplate, templatePromptBlock } from './templates';
import { buildVmContext, recordFailure, clearFailure } from '../context/vmContext';
import { trackRequest, trackToolCall, trackSymbolHit, trackCacheHit, trackIndexHit, trackGrep, trackWindowRead, trackFullFileRead } from '../context/telemetry';
import { compressToolResult, resolveToolArgs, type ResolverEntry } from '../context/toolResultCompressor';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionTracker } from '../context/executionMemory';
import { buildConversationMemory } from '../context/conversationMemory';

export type Mode = 'chat' | 'plan' | 'agent';


/**
 * Tools Plan mode is allowed to use — strictly read-only, so it can research the
 * codebase without ever mutating it. Filtering the full tool list by this set also
 * drops mutating built-ins (write/create/edit/delete/runCommand) and all MCP tools,
 * whose side-effects are unknown.
 */
const READONLY_TOOLS = new Set([
  'readFile', 'listDir', 'repoMap', 'searchWorkspace', 'getDiagnostics', 'codebaseSearch',
  'glob', 'grep', 'webFetch', 'webSearch', 'askUser', 'skill',
  'readImage', 'readDocument',
  'buildGraph', 'getSymbolGraph', 'impactAnalysis',
]);

export interface AgentCallbacks {
  onModel?: (platform: string, model: string, runtimeName?: string) => void;
  onTool?: (event: ToolEvent) => void;
  /** Coarse phase signal for the live "agent is working" status line. */
  onStep?: (phase: 'thinking' | 'synthesizing' | 'done', label: string) => void;
  /**
   * The model's per-step reasoning — the "thinking" it emits alongside a tool-call turn.
   * Fired once per step BEFORE the step's tools run, so the UI can show "think → act"
   * the way Claude Code / Kilo Code do (not just the final answer's reasoning).
   */
  onReasoning?: (text: string) => void;
  /** Live task checklist updates (the agent's updateTodos calls). */
  onTodos?: (todos: TodoItem[]) => void;
  /** Backing for the `askUser` tool: present a question (optionally multiple-choice) and await the answer. */
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
  /**
   * Streaming text delta — called for each token of the final answer as it arrives.
   * Only fires on text-answer turns (not tool-call turns). Lets the UI render text
   * progressively instead of waiting for the full response, matching Cursor/Copilot UX.
   */
  onChunk?: (text: string) => void;
}

/** Per-run options threaded from the chat provider down to the router. */
export interface RunOpts {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  token?: vscode.CancellationToken;
  taskKind?: TaskKind;
  /** Sampling temperature override (0 = deterministic). Set by the benchmark runner for reproducible runs; undefined leaves the provider default. */
  temperature?: number;
  /** Per-attachment kind on the latest user turn, used to upgrade to a vision-capable model. */
  attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'>;
  /** True when the user left the model on Auto. */
  auto?: boolean;
  onFailover?: (i: { from: { platform: string; modelId: string }; reason: string }) => void;
  onKeyRotated?: (i: { platform: string; keyIndex: number; keyTotal: number }) => void;
  /**
   * Session-scoped context for the shared gates: which session's checkpoints to record
   * into, which session's thread to route approvals to, and the live auto-approve read.
   * Omitted for non-chat callers (inline editor chat) → gates use their default behavior.
   */
  runContext?: RunContext;
  /** Benchmark mode: never pause/check-in on iteration cap (would corrupt the answer
   *  and every downstream score). Cap is raised to BENCH_MAX_ITERATIONS instead. */
  bench?: boolean;
}

/** Hard cap when RunOpts.bench is set. Much higher than the user-facing default (25)
 *  so a long-tail query isn't truncated into a useless "I've paused" stub, but still
 *  bounded so a stuck agent can't burn the night. */
const BENCH_MAX_ITERATIONS = 200;

export interface AgentResult {
  text: string;
  reasoning?: string;
  platform?: string;
  model?: string;
  /** Runtime display name for custom endpoints (no-op for built-ins). */
  runtimeName?: string;
  /** Which task kind produced this result — used to attribute 👍/👎 feedback. */
  taskKind?: TaskKind;
  /**
   * The agent's working transcript for this run (assistant tool calls + tool results +
   * final answer), i.e. everything added past the system+history prefix. The caller
   * persists it so a paused/failed run resumes with full memory instead of starting over.
   */
  workMessages?: ChatMessage[];
  /** True when the run stopped before finishing (iteration cap or a model dropping out) and can be resumed. */
  paused?: boolean;
}

/** Split a model's <think>…</think> trace from its visible answer. */
export function splitReasoning(text: string): { reasoning?: string; content: string } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/i.exec(text);
  if (m) return { reasoning: m[1].trim(), content: text.slice(m[0].length).trim() };
  return { content: text };
}

/**
 * The "thinking" a model emits on a tool-call turn. Strong models put it in a separate
 * `reasoning_content` / `reasoning` channel (kept out of `content` so it isn't folded —
 * see normalizeChoices); weaker ones inline a <think>…</think> block or narrate in plain
 * content. We surface whichever is present so each step can show its reasoning before acting.
 */
function turnReasoning(msg: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } | undefined): string {
  if (!msg) return '';
  const channel = typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()
    ? msg.reasoning_content
    : typeof msg.reasoning === 'string' && msg.reasoning.trim()
      ? msg.reasoning
      : '';
  if (channel.trim()) return channel.trim();
  const text = contentToString(msg.content as ChatContent);
  const split = splitReasoning(text);
  // A <think> block is the model's reasoning; otherwise plain narration ("I'll do X next")
  // that came alongside the tool calls also reads as a thinking step worth showing.
  return (split.reasoning ?? split.content ?? '').trim();
}

/**
 * Detect the canned "I only handle code / this workspace" deflection a weak model sometimes
 * emits even after a successful web search. Short + scope-limiting ("only/just … code …
 * can't/here to") — a real answer (longer, or without all three signals) won't match.
 */
const ELIDED_MARK = '[context-trimmed]';

/**
 * Within-run context control. An agent loop re-sends the WHOLE message array on every
 * iteration, so a single 100 KB `readFile` result (or a full-file `createFile`/`writeFile`
 * arg) gets re-billed on each of up to ~25 iterations — the dominant cause of huge input-token
 * counts on trivial tasks. This stales out the BODY of old, large tool results (and old
 * write-call content) in place, while keeping the system prompt, the task, every tool-call
 * structure, and the most recent `keepRounds` tool-call rounds fully intact — so the round the
 * model is about to act on is never touched. The model can re-run a tool if it needs the content
 * again, far cheaper than re-sending it every step. Mutates `messages`; idempotent.
 */
function trimRunTranscript(messages: ChatMessage[], protectBefore: number, keepRounds = 2, maxChars = 2000): void {
  // Round boundaries = assistant turns that carry tool calls. Keep the most recent `keepRounds`
  // rounds whole; anything before `cutoff` (older rounds + their results) is eligible to stale.
  const roundStarts: number[] = [];
  for (let i = protectBefore; i < messages.length; i++) if (messages[i].tool_calls?.length) roundStarts.push(i);
  if (roundStarts.length <= keepRounds) return;
  const cutoff = roundStarts[roundStarts.length - keepRounds];
  for (let i = protectBefore; i < cutoff; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      // Old, large tool RESULT → short stub.
      const text = contentToString(m.content);
      if (text.length > maxChars && !text.startsWith(ELIDED_MARK)) {
        messages[i] = { ...m, content: `${ELIDED_MARK} ${m.name ?? 'tool'} result (${text.length} chars) omitted to save context — re-run the tool if you need it.` };
      }
    } else if (m.tool_calls?.length) {
      // Old write-call ARGS (createFile/writeFile carry the whole file body) → drop the body,
      // keep the path. Safe: the file is already on disk and rarely needs re-reading from args.
      let changed = false;
      const next = m.tool_calls.map((c) => {
        const name = c.function?.name;
        const argStr = c.function?.arguments ?? '';
        if ((name !== 'createFile' && name !== 'writeFile') || argStr.length <= maxChars || argStr.includes(ELIDED_MARK)) return c;
        let path = '';
        try { path = String((JSON.parse(argStr) as { path?: unknown })?.path ?? ''); } catch { /* keep stub generic */ }
        changed = true;
        return { ...c, function: { ...c.function, arguments: JSON.stringify({ path, _note: `${ELIDED_MARK} file content omitted to save context` }) } };
      });
      if (changed) messages[i] = { ...m, tool_calls: next };
    }
  }
}

/**
 * Extract a compact symbol list (class/function names) from file text for use in
 * FILE LOOP hints. Keeps the model oriented on what's in the file without re-sending
 * its full content every time it forgets and re-reads the same file.
 */
function extractFileSymbols(content: string, filePath: string): string {
  const ext = (filePath.split('.').pop() ?? '').toLowerCase();
  let re: RegExp;
  if (ext === 'php') {
    re = /(?:class|interface|trait|function)\s+(\w+)/g;
  } else if (['ts', 'tsx', 'js', 'jsx', 'mjs'].includes(ext)) {
    re = /(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=/g;
  } else {
    re = /(?:function|class|def|fn)\s+(\w+)/g;
  }
  const symbols: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1] || m[2];
    if (name && !symbols.includes(name)) { symbols.push(name); if (symbols.length >= 15) break; }
  }
  return symbols.join(', ');
}

function looksLikeCodeRefusal(text: string): boolean {
  // Normalize curly apostrophes so "can't" / "can’t" both match.
  const t = (text || '').toLowerCase().replace(/[’‘]/g, "'").trim();
  if (!t || t.length > 600) return false;
  const scoped = /\b(only|just|set up to|designed to|here to|meant to)\b/.test(t);
  const codey = /\b(code|coding|workspace|software|programming|development|this project)\b/.test(t);
  const declines = /\b(can't|cannot|unable|not able|don't|do not|won't|isn't something)\b/.test(t);
  return scoped && codey && declines;
}

export class Agent {
  constructor(
    private readonly router: Router,
    private readonly tools: WorkspaceTools,
    private readonly mcp?: McpManager,
    private readonly index?: CodebaseIndex,
  ) {}

  /** Tracks files modified + commands run across all runs in this session (per Agent instance = per chat). */
  private readonly execTracker = new ExecutionTracker();

  /** Cached project-identity summary, keyed by workspace root (rarely changes mid-session). */
  private groundingCache?: { root: string; text: string };

  /**
   * Per-session deduplication caches: maps sessionId → (toolName:argStr → result).
   * Each session's cache is cleared at the start of its own run, so concurrent sessions
   * never wipe each other's in-flight cache entries.
   * Falls back to key '__standalone__' for non-chat callers (inline editor, tests).
   */
  private sessionDedup = new Map<string, Map<string, string>>();

  private static readonly DEDUP_TOOLS = new Set([
    'grep', 'glob', 'readFile', 'repoMap', 'getDiagnostics', 'codebaseSearch', 'webSearch', 'webFetch',
  ]);

  /** Get (or create) the dedup map for a session. */
  private dedupFor(sessionId: string): Map<string, string> {
    let m = this.sessionDedup.get(sessionId);
    if (!m) { m = new Map(); this.sessionDedup.set(sessionId, m); }
    return m;
  }

  /**
   * Research Result Persistence: session-level cache of pre-research bundles keyed by
   * search terms. When a follow-up query ("now add API") shares ≥2 terms with a prior
   * query ("add delivery slots" → found StoreController, StoreSchedule), we prepend the
   * prior bundle so the model already knows the relevant files without re-running research.
   * TTL: 10 minutes — long enough for multi-turn tasks, short enough to stay fresh.
   */
  private researchHistory: Array<{ terms: string[]; bundle: string; ts: number }> = [];
  private static readonly RESEARCH_HISTORY_TTL = 10 * 60 * 1000;

  private findPriorResearch(terms: string[]): string | undefined {
    const now = Date.now();
    // Evict stale entries first.
    this.researchHistory = this.researchHistory.filter((e) => now - e.ts < Agent.RESEARCH_HISTORY_TTL);
    const termSet = new Set(terms.map((t) => t.toLowerCase()));
    // Find the most recent entry with ≥2 overlapping search terms.
    for (let i = this.researchHistory.length - 1; i >= 0; i--) {
      const entry = this.researchHistory[i];
      const overlap = entry.terms.filter((t) => termSet.has(t.toLowerCase())).length;
      if (overlap >= 2) return entry.bundle;
    }
    return undefined;
  }

  private saveResearch(terms: string[], bundle: string): void {
    this.researchHistory.push({ terms, bundle, ts: Date.now() });
    // Keep only the last 10 entries to bound memory.
    if (this.researchHistory.length > 10) this.researchHistory.shift();
  }

  private maxIterations(): number {
    return vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxIterations', 25);
  }

  /** Handle an `updateTodos` tool call: push the list to the UI, return a short ack. */
  private applyTodos(args: unknown, cb: AgentCallbacks): string {
    const raw = (args as { todos?: unknown })?.todos;
    const valid = new Set(['pending', 'in_progress', 'completed']);
    const todos: TodoItem[] = Array.isArray(raw)
      ? raw
          .map((t) => ({ content: String((t as TodoItem)?.content ?? '').trim(), status: (t as TodoItem)?.status }))
          .filter((t): t is TodoItem => !!t.content && valid.has(t.status as string))
      : [];
    if (todos.length) cb.onTodos?.(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return JSON.stringify({ ok: true, total: todos.length, completed: done });
  }

  /** Project grounding for the system prompt, memoized per workspace root. */
  private async grounding(): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
    if (this.groundingCache?.root === root) return this.groundingCache.text;
    const text = await loadProjectGrounding();
    this.groundingCache = { root, text };
    return text;
  }

  /** Lazy graph context: load existing graph, or build file-level graph if absent. */
  private async graphContext(): Promise<string> {
    try {
      if (!vscode.workspace.getConfiguration('tiermux.graph').get<boolean>('enabled', false)) return '';
      let graph = await loadStructuralGraph();
      if (!graph) {
        graph = await buildStructuralGraph(false);
      }
      if (!graph || graph.files.length === 0) return '';
      return graphSummary(graph);
    } catch { return ''; }
  }

  /**
   * Free, model-free style inference from this run's file edits, persisted to
   * .tiermux/memory.md's auto-learned section. Fire-and-forget — memory is non-critical and
   * this must never block or break a run. Gated by `tiermux.memory.autoLearn` (default on).
   */
  private maybeLearnStyle(workMsgs: ChatMessage[]): void {
    try {
      if (!vscode.workspace.getConfiguration('tiermux.memory').get<boolean>('autoLearn', true)) return;
      const rules = inferStyleFromEdits(workMsgs);
      if (rules) void upsertLearnedSection(rules).catch(() => { /* best-effort */ });
    } catch { /* never break a run for memory */ }
  }

  /**
   * Quality-based escalation: run one route attempt, and if the response looks unhandled
   * (refusal/empty, a verbatim tool-call loop, or all-unparseable tool calls), retry on a
   * strictly-not-weaker model up to ESCALATION_CAP times. A first-hop failure is a real
   * error (rethrown so the caller can pause/surface it); a later-hop "no stronger model"
   * failure returns the last result so we never make things worse. `prevSig` (tool-call
   * signature of the previous iteration) enables cross-iteration loop detection.
   */
  private async routeEscalated(
    messages: ChatMessage[],
    baseOpts: RouteOptions,
    cb: AgentCallbacks,
  ): Promise<Awaited<ReturnType<Router['route']>>> {
    const result = await this.router.route(messages, { ...baseOpts, onChunk: cb.onChunk });
    const toolCalls = result.response.choices[0]?.message?.tool_calls ?? [];
    for (const call of toolCalls) {
      if (call.function?.name) call.function.name = sanitizeToolName(call.function.name);
    }
    return result;
  }

  /** Backing for the `askUser` tool: ask the user (free-text or multiple-choice) and return the answer. */
  private async askUser(args: unknown, cb: AgentCallbacks): Promise<string> {
    const question = String((args as { question?: unknown })?.question ?? '').trim() || 'The agent needs a clarification:';
    const rawOptions = (args as { options?: unknown })?.options;
    const options = Array.isArray(rawOptions) ? rawOptions.map((o) => String(o)).filter(Boolean) : undefined;
    if (!cb.onAskUser) return JSON.stringify({ answer: '(no way to reach the user right now)' });
    const answer = await cb.onAskUser(question, options);
    return JSON.stringify({ answer: answer && answer.trim() ? answer.trim() : '(user skipped this question)' });
  }

  async run(
    history: ChatMessage[],
    mode: Mode,
    opts: RunOpts,
    cb: AgentCallbacks = {},
  ): Promise<AgentResult> {
    // Show the "Working…" indicator immediately — before grounding/context prep and
    // the (slow, free-tier) model call — so the UI never looks frozen while waiting. This is
    // the generic busy status, NOT reasoning: the word "Thinking" is reserved for the 🧠 block
    // that renders actual model reasoning, so a greeting like "hi" never mislabels itself.
    cb.onStep?.('thinking', 'Working…');
    const sessionId = opts.runContext?.sessionId ?? '__standalone__';
    this.dedupFor(sessionId).clear();

    const latestText = contentToString([...history].reverse().find((m) => m.role === 'user')?.content ?? '');

    // Trivial greetings ("hi", "hello", "thanks"…): skip tools, context load, and web search
    // entirely — just give a warm one-shot reply. Applies in all modes so Ask mode doesn't
    // accidentally web-search "hi".
    if (classifyTask(latestText) === 'trivial') {
      // Greetings get an instant hardcoded reply — no model call needed.
      // Sending "hello" to a free LLM API costs 30-60s of latency for zero value.
      const GREETINGS = [
        "Hey! What would you like to build or fix today?",
        "Hi there! Ask me anything about your code.",
        "Hello! Ready when you are — what are we working on?",
        "Hey! Drop a question or a task and I'll get started.",
      ];
      const idx = latestText.length % GREETINGS.length; // deterministic, no Math.random()
      return { text: GREETINGS[idx], platform: 'local', model: 'instant', taskKind: 'trivial' };
    }

    // A bare "yes / ok / go ahead" replying to the model's OWN offer: weaker models often stall
    // here and even hallucinate "I don't have the tools" instead of acting. Detect it and nudge
    // them to carry out what they just proposed — turning a one-word confirmation into an action.
    const BARE_CONFIRM = /^(y|yes|yeah|yep|sure|ok|okay|go ahead|please do|do it|continue|proceed|sounds good|that works)\b[\s!.?]*$/i;
    let continuationHint = '';
    if (BARE_CONFIRM.test(latestText.trim())) {
      let prevAssistant = '';
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant') { prevAssistant = contentToString(history[i].content); break; }
      }
      if (prevAssistant && /\?/.test(prevAssistant)) {
        continuationHint = `\n\n# User confirmation\nThe user just replied "${latestText.trim()}". They are confirming the action YOU proposed in your previous message — proceed with it now using your tools. Do not ask again, do not restate options, and never claim you lack tools: you have grep/glob/readFile/etc. Use them.`;
      }
    }

    // Ask: web-only by default, BUT codebase questions ("how does X work in this project?")
    // need code tools too. Detect early so grounding + pre-research fire for those.
    const isCodebaseQ = mode === 'chat' && isCodebaseQuestion(latestText);
    const wantsCodeContext = mode !== 'chat' || isCodebaseQ;
    // For Agent mode: classify the content to pick the right model tier automatically.
    //   "what does X do?"           → 'chat'   → speed-first (fast 70B, no heavy model needed)
    //   "fix the null pointer bug"  → 'debug'  → tools + reasoning models prioritised
    //   "refactor the auth service" → 'coding' → coding-tagged models first
    //   "implement a payment flow"  → 'agent'  → full tools + balanced intelligence/speed
    // Ask/Plan modes stay on their own ordering (chat=speed, plan=balanced+reasoning).
    const contentKind = mode === 'agent' ? classifyTask(latestText, { attachmentKinds: opts.attachmentKinds }) : modeToKind(mode);
    const routeKind: TaskKind = contentKind;
    const ropts: RunOpts = { ...opts, taskKind: routeKind };

    // Execution template: pick recipe based on query keywords (agent mode only).
    // Chat/Plan use their own fixed tool sets so templates don't apply there.
    const template = mode === 'agent' ? getTemplate(pickTemplate(latestText)) : undefined;

    const [rules, grounding, memory] = await Promise.all([loadProjectRules(), this.grounding(), loadUserMemory()]);
    const graphContext = wantsCodeContext ? await this.graphContext() : '';
    const augment = (base: string): string => {
      // Today's date so the model interprets "today", "yesterday", "this week" correctly
      // when answering time-sensitive questions or reading web-search results.
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      let s = `${base}\n\n${RESPONSIBILITY_RULES}\n\n# Current date\nToday is ${today}.`;
      if (wantsCodeContext && grounding) s += `\n\n# Project context (orient yourself here first)\n${grounding}`;
      if (graphContext) s += `\n\n# Code graph (structural relationships)\n${graphContext}`;
      if (memory) s += `\n\n# User style, tone & standing instructions (follow exactly)\n${memory}`;
      if (wantsCodeContext && rules) s += `\n\n# Project rules (follow these)\n${rules}`;
      if (continuationHint) s += continuationHint;
      return s;
    };
    const augmented = await this.prepareContext(history, wantsCodeContext);
    // Score workspace-vs-web relevance and steer the tool loop with a "search X first" hint, rather
    // than hard-locking the model into a single toolset. Only injected into paths that actually hold
    // BOTH code + web tools (the runAgent loop) — the web-only runChat path can't search the workspace.
    const infoHint = informationSourceHint(classifyInformationNeed(latestText));

    // Context lookup: symbolIndex (O(1)) → bundleCache (Jaccard) → grep (fallback).
    // Each layer feeds the next: symbolIndex hits become bundleCache symbols; grep output
    // is compressed into a summary before caching — model never sees raw grep text.
    const route = wantsCodeContext ? classifyInformationRoute(latestText) : undefined;
    // Load graph once — used for pre-research lookup AND tool result compression (FLOW chain).
    // Lazily build if absent: tiermux.graph.enabled gates context injection, NOT the symbol index
    // (the symbol index is a zero-cost O(1) lookup — we always want it available).
    let structGraph = wantsCodeContext ? await loadStructuralGraph().catch(() => undefined) : undefined;
    if (!structGraph && wantsCodeContext && route?.codeSearch) {
      try { structGraph = await buildStructuralGraph(false); } catch { /* non-critical */ }
    }
    let preResearch = '';
    if (route?.codeSearch && route.searchTerms.length) {
      trackRequest();
      // 1. symbolIndex — O(1) exact + fuzzy lookup from structural graph (no disk I/O).
      // Stem each term so "calculated" → tries "calculat" → hits "calculatePrice".
      // Each term is searched both as-is AND with common English suffixes stripped.
      const graph = structGraph;
      const stemTerm = (t: string): string[] => {
        const stems = [t];
        if (t.endsWith('ated') && t.length > 6) stems.push(t.slice(0, -2));   // calculated→calculat
        if (t.endsWith('tion') && t.length > 6) stems.push(t.slice(0, -4));   // calculation→calculat
        if (t.endsWith('ing') && t.length > 5)  stems.push(t.slice(0, -3));   // calculating→calculat
        if (t.endsWith('ed') && t.length > 4)   stems.push(t.slice(0, -2));   // stored→stor
        if (t.endsWith('s') && t.length > 4)    stems.push(t.slice(0, -1));   // prices→price
        if (t.endsWith('er') && t.length > 5)   stems.push(t.slice(0, -2));   // cheaper→cheap
        if (t.endsWith('est') && t.length > 5)  stems.push(t.slice(0, -3));   // cheapest→cheap
        return [...new Set(stems)];
      };
      const symbolHits = graph
        ? route.searchTerms.flatMap((t) =>
            stemTerm(t).flatMap((stem) => searchSymbols(getOrBuildSymbolIndex(graph), stem, 4)),
          )
        : [];
      // Deduplicate hits (same file:line may appear from multiple stems)
      const seenSym = new Set<string>();
      const dedupedHits = symbolHits.filter((h) => {
        const k = `${h.file}:${h.line}`;
        if (seenSym.has(k)) return false;
        seenSym.add(k);
        return true;
      });
      if (dedupedHits.length) trackSymbolHit(); // track ANY symbol index contribution
      const symbolSection = dedupedHits.length ? formatSymbolHits(dedupedHits) : '';

      // Fast exit: if symbol index covers all search terms, skip everything else.
      const symbolCoverage = route.searchTerms.length === 0 ? 0
        : route.searchTerms.filter((t) =>
            dedupedHits.some((h) => h.name.toLowerCase().includes(t.toLowerCase()) ||
              stemTerm(t).some((s) => h.name.toLowerCase().includes(s.toLowerCase()))),
          ).length / route.searchTerms.length;
      if (symbolCoverage >= 0.8) {
        // High confidence — symbol index covers this query. Skip bundleCache + index + grep.
        preResearch = symbolSection;
        void saveBundle({ terms: route.searchTerms, files: [], symbols: dedupedHits.map((h) => ({ name: h.name, file: h.file, line: h.line, kind: h.kind })), patterns: route.searchTerms, summary: symbolSection, hitScore: 1, confidence: symbolCoverage, ttl: 24 * 60 * 60 * 1000 });
      } else {
        // 2. bundleCache — Jaccard match, confidence-gated injection.
        const cached = await lookupBundle(route.searchTerms).catch(() => undefined);
        if (cached) {
          trackCacheHit();
          preResearch = formatBundle(cached);
          if (symbolSection) preResearch = symbolSection + '\n\n' + preResearch;
        } else {
          // 3. Inverted index (precomputed, O(1)) — covers terms not found in symbol index.
          const uncoveredBySymbol = dedupedHits.length
            ? route.searchTerms.filter((t) => !stemTerm(t).some((s) => dedupedHits.some((h) => h.name.toLowerCase().includes(s.toLowerCase()))))
            : route.searchTerms;

          const fresh = await indexIsFresh();
          let indexSection = '';
          let termsForGrep = uncoveredBySymbol.slice(0, 3);
          if (fresh && uncoveredBySymbol.length) {
            const { hits, misses } = await lookupInvertedIndex(uncoveredBySymbol);
            if (hits.length) { trackIndexHit(); indexSection = formatIndexHits(hits); }
            termsForGrep = misses.slice(0, 2); // grep only what index doesn't know
          }

          // 4. grep — only for terms the index missed (regex patterns, brand-new files).
          const rawGrep = termsForGrep.length
            ? (await Promise.all(
                termsForGrep.map((term) => {
                  trackGrep();
                  return this.tools.execute('grep', JSON.stringify({ pattern: term, maxResults: 5 }), opts.runContext)
                    .then((r) => String(r))
                    .catch(() => '');
                }),
              )).filter(Boolean).join('\n\n')
            : '';

          // Compress all sources into summary + symbols — never cache raw text.
          const compressed = compressGrepResults([indexSection, rawGrep].filter(Boolean).join('\n\n'), route.searchTerms);
          for (const h of dedupedHits) {
            if (!compressed.symbols.find((s) => s.name === h.name)) {
              compressed.symbols.push({ name: h.name, file: h.file, line: h.line, kind: h.kind });
            }
          }
          const mergedConfidence = Math.max(compressed.confidence, dedupedHits.length > 0 ? 0.8 : 0);
          void saveBundle({ ...compressed, terms: route.searchTerms, confidence: mergedConfidence, ttl: 24 * 60 * 60 * 1000 });

          preResearch = [symbolSection, compressed.summary].filter(Boolean).join('\n\n');
        }
      }

      // Session memory: prepend prior research for follow-up queries in same session.
      const prior = this.findPriorResearch(route.searchTerms);
      if (prior && prior !== preResearch) preResearch = prior + (preResearch ? `\n\n---\n\n${preResearch}` : '');
      if (preResearch) this.saveResearch(route.searchTerms, preResearch);
    }

    const withResearch = (base: string): string =>
      base + (preResearch ? `\n\n${preResearch}` : '');

    // Agent mode: build full VM context (ACTIVE_FILE + SYMBOL_HITS + LAST_ERROR + GIT_DIFF + GOAL).
    // Chat/Plan keep the simpler preResearch path — VM context is only for the execution engine.
    console.log('[TierMux] PRE_RESEARCH_BUILT', { route: route?.intent, codeSearch: route?.codeSearch, preResearchLen: preResearch.length, preResearch: preResearch.slice(0, 400) });
    const vmContext = mode === 'agent'
      ? await buildVmContext({ symbolHits: preResearch, goal: latestText, sessionId }).catch(() => preResearch)
      : null;
    console.log('[TierMux] VM_CONTEXT_BUILT', { vmContextLen: vmContext?.length ?? 0, vmContext: vmContext?.slice(0, 500) });

    // Conversation memory: compressed last 3-5 turns → previous goal + files in context.
    // Injected BEFORE the structured context so the model understands "continue X" intent
    // without re-searching for files it already knows about.
    const convMem = mode !== 'chat'
      ? buildConversationMemory(history, this.execTracker)
      : '';

    const withVmContext = (base: string): string => {
      const conv = convMem ? `\n\n${convMem}` : '';
      const ctx = vmContext
        ? `\n\n# PRE-RESEARCH — MANDATORY: readFile these exact locations first, then answer. Skip grep entirely if these files are listed.\n${vmContext}`
        : (preResearch ? `\n\n# PRE-RESEARCH — MANDATORY: readFile these exact locations first, then answer. Skip grep entirely if these files are listed.\n${preResearch}` : '');
      return base + conv + ctx;
    };

    // Append template recipe block to the agent system prompt (agent mode only).
    const withTemplate = (base: string): string =>
      template ? base + `\n\n${templatePromptBlock(template)}` : base;

    let result: AgentResult;
    try {
      if (mode === 'chat') {
        const webOn = vscode.workspace.getConfiguration('tiermux.tools').get<boolean>('web', true);
        if (isCodebaseQ) {
          const askCodeSystem = withResearch(augment(CHAT_SYSTEM) + infoHint);
          result = await this.runAgent(augmented, askCodeSystem, ropts, cb, { readOnly: true, graph: structGraph });
        } else {
          result = webOn
            ? await this.runChat(augmented, augment(CHAT_SYSTEM), ropts, cb)
            : await this.runSingle(augmented, augment(CHAT_SYSTEM), ropts, cb);
        }
      } else if (mode === 'plan') {
        result = await this.runAgent(augmented, withResearch(augment(PLAN_SYSTEM)), ropts, cb, { readOnly: true, graph: structGraph });
      } else {
        // Agent mode: full VM context + template recipe + tool restriction.
        const agentSystem = withTemplate(withVmContext(augment(AGENT_SYSTEM)));
        result = await this.runAgent(augmented, agentSystem, ropts, cb, {
          allowedTools: template?.allowedTools,
          graph: structGraph,
        });
      }
    } finally {
      // Release this run's edit-advisory claims whether it finished, failed, or was cancelled,
      // so a subsequent run isn't falsely told the files are still being edited.
      unmarkEditing(opts.runContext?.requestId);
    }
    // Record file writes/edits from this run so conversationMemory can surface them next turn.
    if (result.workMessages?.length) {
      this.execTracker.record(result.workMessages);
    }
    // Reset tracker on a brand-new chat (no prior history = user started fresh).
    if (history.filter((m) => m.role === 'user').length <= 1) {
      this.execTracker.reset();
    }
    result.taskKind = routeKind;
    return result;
  }



  /** Insert a context turn (ambient editor context + auto-retrieved code) before the latest user
   *  message. Skipped for non-codebase questions (`includeCode=false`) — a web/factual question
   *  doesn't need the open-editor dump or retrieved code chunks, and skipping them keeps its
   *  prompt small. */
  private async prepareContext(history: ChatMessage[], includeCode = true): Promise<ChatMessage[]> {
    const blocks: string[] = [];
    if (includeCode) {
      const ambient = buildAmbientContext();
      if (ambient) blocks.push(`Editor context:\n${ambient}`);
      const retrieved = await this.retrieve(history);
      if (retrieved) blocks.push(retrieved);
    }
    if (!blocks.length) return history;

    let lastUserIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) { if (history[i].role === 'user') { lastUserIdx = i; break; } }
    if (lastUserIdx === -1) return history;
    const ctxMsg: ChatMessage = { role: 'user', content: blocks.join('\n\n') };
    return [...history.slice(0, lastUserIdx), ctxMsg, ...history.slice(lastUserIdx)];
  }

  /** Embed the latest user message and return the top matching code chunks (or ''). */
  private async retrieve(history: ChatMessage[]): Promise<string> {
    const autoOn = vscode.workspace.getConfiguration('tiermux.embeddings').get<boolean>('autoContext', true);
    if (!autoOn || !this.index || !this.index.isEnabled() || !this.index.hasIndex()) return '';
    let lastUser: ChatMessage | undefined;
    for (let i = history.length - 1; i >= 0; i--) { if (history[i].role === 'user') { lastUser = history[i]; break; } }
    const query = contentToString(lastUser?.content).slice(0, 2000);
    if (!query.trim()) return '';
    let results;
    try { results = await this.index.search(query, 5); } catch { return ''; }
    if (!results.length) return '';
    const block = results
      .map((r) => '```\n' + `// ${r.file}:${r.startLine}-${r.endLine}\n` + r.text.replace(/^\/\/.*\n/, '').slice(0, 1500) + '\n```')
      .join('\n\n');
    return `Relevant code from the workspace (auto-retrieved — use if helpful):\n\n${block}`;
  }

  /** One-shot completion (chat or plan): no tools. */
  private async runSingle(
    history: ChatMessage[],
    system: string,
    opts: RunOpts,
    cb: AgentCallbacks,
  ): Promise<AgentResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];
    cb.onStep?.('thinking', 'Working…');
    const result = await this.routeEscalated(messages, {
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      taskKind: opts.taskKind,
      temperature: opts.temperature,
      onFailover: opts.onFailover,
      onKeyRotated: opts.onKeyRotated,
    }, cb);
    cb.onModel?.(result.platform, result.model);
    const raw = contentToString(result.response.choices[0]?.message.content);
    const { reasoning, content } = splitReasoning(raw);
    return { text: content, reasoning, platform: result.platform, model: result.model, runtimeName: result.runtimeName };
  }

  /**
   * Tool-calling loop for Agent/Debug modes — and, in read-only form, Plan mode's
   * research pass. With `readOnly`, only the look-don't-touch tools are offered, so
   * Plan can investigate the real code before proposing a plan but can never mutate it.
   */
  private async runAgent(
    history: ChatMessage[],
    system: string,
    opts: RunOpts,
    cb: AgentCallbacks,
    runOpts?: { readOnly?: boolean; weak?: boolean; allowedTools?: string[]; graph?: StructuralGraph },
  ): Promise<AgentResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];
    // Everything appended past this prefix is the agent's working transcript; it's
    // returned as workMessages so a paused/failed run can resume with full memory.
    const baseLen = messages.length;
    const work = (): ChatMessage[] => messages.slice(baseLen);
    let lastPlatform: string | undefined;
    let lastModel: string | undefined;
    let lastRuntimeName: string | undefined;
    const weak = !!runOpts?.weak;

    if (this.mcp && !runOpts?.readOnly && !weak) { try { await this.mcp.ensureStarted(); } catch { /* MCP optional */ } }
    const indexOn = !weak && !!this.index && this.index.isEnabled() && this.index.hasIndex();
    // Tool selection by capability. Weak free models get ONLY the core search/read/edit/verify
    // set — fewer choices means they pick the right tool and emit valid calls. Strong models get
    // the full set. Read-only runs (questions/research/plan) are then filtered to safe tools.
    const webOn = vscode.workspace.getConfiguration('tiermux.tools').get<boolean>('web', true);
    const graphOn = vscode.workspace.getConfiguration('tiermux.graph').get<boolean>('enabled', false);
    const tools = weak
      ? CORE_TOOL_SPECS
      : [
        THINK_SPEC,
        ...TOOL_SPECS,
        GLOB_SPEC, GREP_SPEC, ASK_USER_SPEC, SKILL_SPEC, READ_IMAGE_SPEC, READ_DOCUMENT_SPEC,
        ...(webOn ? WEB_TOOL_SPECS : []),
        ...(graphOn ? GRAPH_TOOLS_SPEC : []),
        ...(indexOn ? [CODEBASE_SEARCH_SPEC] : []),
        ...(runOpts?.readOnly ? [] : this.mcp?.listToolSpecs() ?? []),
      ];
    const toolsFiltered = tools.filter((t) => {
      if (runOpts?.readOnly && !READONLY_TOOLS.has(t.function.name)) return false;
      if (runOpts?.allowedTools && !runOpts.allowedTools.includes(t.function.name)) return false;
      return true;
    });
    // Teach weak models the XML text tool-protocol so they can ACT even when the provider
    // ignores native function-calling — the dominant "replies with prose, never edits" failure.
    // Strong models keep native calling untouched; the parser below is a harmless safety net.
    if (weak) messages[0] = { role: 'system', content: `${system}\n\n${textToolProtocolPrompt(toolsFiltered)}` };
    let prevSig = '';
    // Auto orchestration (strong models only): phase routing (reason → execute) and a bounded
    // auto-escalation past the step cap. Weak free models get a SIMPLE single-model path instead
    // — phase switching and extra escalation batches hurt them (they can't hand off context well,
    // and re-sending the growing history burns their tiny free-tier budget).
    void opts.auto; // auto-escalation removed
    const baseKind = opts.taskKind ?? 'agent';
    const baseBudget = opts.bench ? BENCH_MAX_ITERATIONS : this.maxIterations();
    const hardCeiling = baseBudget;
    let floor: number | undefined;
    let totalIter = 0;
    // Consecutive grep counter: if the model greps 3+ times in a row without a readFile,
    // append a strong hint to the next grep result to break the loop.
    // This is the primary cause of 400+ second hangs on free LLMs after editFile fails.
    let consecutiveGreps = 0;
    // Per-file read counter: tracks how many times each file has been read this run.
    // If a file is read 2+ times the model is stuck on it — inject a redirect hint with
    // a compact symbol list so it can navigate without re-reading the full content.
    const fileReadCount = new Map<string, number>();
    // Compact symbol summary per file (extracted on first read). Injected into FILE LOOP hints
    // so the model knows what's in the file without needing to re-read it.
    const fileSummaryCache = new Map<string, string>(); // normalised path → "fn1, fn2, cls1"
    // Path resolver: alias (model-facing short name) → ResolverEntry (full path + optional line hint).
    // Built incrementally from grep results; applied before executeToolCall.
    const pathResolver = new Map<string, ResolverEntry>();
    // Validate that a resolved path still exists on disk (TTL check).
    // On failure the caller removes the stale alias from pathResolver.
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const validateResolvedPath = wsRoot
      ? (relPath: string): boolean => fs.existsSync(path.join(wsRoot, relPath))
      : undefined;

    while (totalIter < hardCeiling) {
      const phaseBudget = hardCeiling - totalIter;
      for (let i = 0; i < phaseBudget; i++, totalIter++) {
      // Cancel = stop, not pause: don't persist a partial transcript (it could end on an
      // assistant tool_calls turn with no tool results, which would break the next request).
      if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };

      cb.onStep?.('thinking', 'Working…');
      // Keep the per-request payload from ballooning: stale out old, large tool results/write
      // bodies before re-sending the transcript (a 100 KB read shouldn't be re-billed 25×).
      // keepRounds=1: only the last round kept in full. maxChars=800: trim old results faster.
      // Old default (2, 2000) allowed 60KB of file content to re-appear every model call.
      trimRunTranscript(messages, baseLen, 1, 800);
      const phaseKind = baseKind;
      let result: Awaited<ReturnType<Router['route']>>;
      let unhandled: string | undefined;
      try {
        const routed = await this.routeEscalated(messages, {
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          taskKind: phaseKind,
          temperature: opts.temperature,
          tools: toolsFiltered,
          tool_choice: 'auto',
          requireTools: true,
          maxIntelligenceRank: floor,
          onFailover: opts.onFailover,
          onKeyRotated: opts.onKeyRotated,
        }, cb);
        result = routed;
        trackRequest();
      } catch (e) {
        // Free models frequently drop out mid-task. If we've already made progress, pause
        // and hand back the work so far so the user can resume; if it failed on the very
        // first call (no progress yet), surface the error through the normal path.
        if (messages.length > baseLen) {
          if (opts.bench) {
            // Bench: never pause. Re-throw so the runner records the error and continues.
            throw e;
          }
          return {
            text: '⚠️ The model stopped responding partway through. Your progress is saved — choose **Continue** and I’ll pick up where I left off.',
            platform: lastPlatform, model: lastModel, workMessages: work(), paused: true,
          };
        }
        throw e;
      }
      lastPlatform = result.platform;
      lastModel = result.model;
      lastRuntimeName = result.runtimeName;
      cb.onModel?.(result.platform, result.model, result.runtimeName);

      const msg = result.response.choices[0]?.message;
      let toolCalls = msg?.tool_calls ?? [];
      // Clean any leaked Harmony/control tokens from tool names (e.g. gpt-oss emits
      // `searchWorkspace<|channel|>commentary`) so calls resolve and history stays consistent.
      for (const call of toolCalls) {
        if (call.function?.name) call.function.name = sanitizeToolName(call.function.name);
      }

      // Fallback for models that ignore native function-calling: parse the XML text protocol
      // out of the reply. This is what makes weak free models ACT instead of just describing
      // the change in prose (the #1 "feels like a chatbot, never edits" failure).
      let textMode = false;
      if (toolCalls.length === 0) {
        const parsed = parseTextToolCalls(contentToString(msg?.content), toolsFiltered);
        if (parsed.length) { toolCalls = parsed; textMode = true; }
      }

      const msgText = contentToString(msg?.content);

      if (toolCalls.length === 0) {
        const { reasoning, content } = splitReasoning(msgText);
        // Record the final answer so it's part of the persisted transcript too.
        messages.push({ role: 'assistant', content: content || '_Done._' });
        this.maybeLearnStyle(work());
        return { text: content || '_Done._', reasoning, platform: lastPlatform, model: lastModel, runtimeName: lastRuntimeName, workMessages: work(), paused: false };
      }

      // `unhandled` is the NATIVE escalation verdict (stuck loop / garbage args from a stronger
      // model). A successful text-protocol parse means the model actually acted, so it doesn't
      // apply — only bail here when we're NOT in text mode.
      if (unhandled && !textMode) {
        messages.push({ role: 'assistant', content: msgText || '_The model could not make progress._', tool_calls: toolCalls });
        this.maybeLearnStyle(work());
        if (opts.bench) {
          // Bench: never pause. Return whatever the model produced as the final answer
          // (likely will score 0, but at least it's not a "click Continue" stub).
          return { text: msgText || '_The model could not make progress._', platform: lastPlatform, model: lastModel, workMessages: work(), paused: false };
        }
        return {
          text: "⚠️ I'm stuck — the model kept repeating itself or couldn't form valid tool calls, even after retrying with a stronger model. Choose **Continue** to try again, or rephrase the task.",
          platform: lastPlatform, model: lastModel, workMessages: work(), paused: true,
        };
      }

      // Text-mode loop guard: detect repeated XML tool blocks and bail.
      const curSig = toolCalls.map((c) => c.function.name + ':' + c.function.arguments).join('|');
      if (textMode && prevSig && curSig === prevSig) {
        messages.push({ role: 'assistant', content: contentToString(msg?.content) });
        this.maybeLearnStyle(work());
        return {
          text: "⚠️ I'm stuck — the model kept repeating the same step. Choose **Continue** to try again, or rephrase the task.",
          platform: lastPlatform, model: lastModel, workMessages: work(), paused: true,
        };
      }
      prevSig = curSig;

      // Show the model's thinking for this step BEFORE its tools run, so the UI reads
      // "think → act" each step (like Claude Code / Kilo Code) — not only at the end.
      const stepThought = turnReasoning(msg);
      if (stepThought) cb.onReasoning?.(stepThought);

      if (textMode) {
        // Mirror the turn as plain TEXT (assistant reply + user-role results) so providers
        // without native tool-calling keep a consistent, replayable transcript.
        messages.push({ role: 'assistant', content: contentToString(msg?.content) });
        const results: string[] = [];
        for (const call of toolCalls) {
          if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
          call.function.arguments = resolveToolArgs(call.function.name, call.function.arguments, pathResolver, validateResolvedPath);
          trackToolCall();
          let { obsText } = await this.executeToolCall(call, opts, cb);
          const { text: compressedText, resolver } = compressToolResult(call.function.name, obsText, call.function.arguments, runOpts?.graph);
          obsText = compressedText;
          for (const [k, v] of resolver) pathResolver.set(k, v);
          if (call.function.name === 'grep') {
            consecutiveGreps++;
            // Reject patterns < 4 chars — they match directory names / everything and
            // are never useful as a code search signal. Redirect to pre-research.
            try {
              const gArgs = JSON.parse(call.function.arguments) as { pattern?: string };
              if (typeof gArgs.pattern === 'string' && gArgs.pattern.trim().length < 4) {
                obsText = `⚠️ Pattern "${gArgs.pattern}" is too short to be a useful search signal. If PRE-RESEARCH in your context already lists file locations, use readFile on those exact files instead. Otherwise grep for a specific function name, class name, or method (4+ characters).`;
              }
            } catch { /* ignore */ }
            if (consecutiveGreps >= 2) {
              obsText += `\n\n⚠️ TOOL LOOP: grep called ${consecutiveGreps}× in a row. STOP grepping. Call readFile on the most relevant file above to get its full content — then use that exact text in your next editFile call.`;
            }
          } else if (call.function.name === 'readFile') {
            consecutiveGreps = 0;
            const readArgs = JSON.parse(repairBrokenJson(call.function.arguments)) as { path?: unknown; startLine?: unknown };
            const filePath = String(readArgs.path ?? '');
            // Track window vs full-file read AFTER resolveToolArgs may have injected startLine
            if (readArgs.startLine !== undefined) { trackWindowRead(); } else { trackFullFileRead(); }
            if (filePath) {
              // Normalize path for dedup — prevents case/slash differences from bypassing the cache
              const normPath = filePath.replace(/\\/g, '/').toLowerCase();
              const count = (fileReadCount.get(normPath) ?? 0) + 1;
              fileReadCount.set(normPath, count);
              if (count === 1) {
                // Populate symbol summary on FIRST read regardless of window (windowed reads
                // give partial symbols but that's better than nothing for the FILE LOOP hint)
                try {
                  const parsed = JSON.parse(obsText) as { content?: string };
                  const syms = extractFileSymbols(parsed?.content ?? '', filePath);
                  if (syms && !fileSummaryCache.has(normPath)) fileSummaryCache.set(normPath, syms);
                } catch { /* best-effort */ }
              }
              if (count >= 2) {
                const syms = fileSummaryCache.get(normPath) ?? '';
                obsText += `\n\n⚠️ FILE LOOP: "${filePath}" read ${count}× — do NOT read again. ${syms ? `Key symbols: ${syms}. ` : ''}If you need a specific section, grep for the function name instead.`;
              }
            }
          } else if (call.function.name !== 'think' && call.function.name !== 'updateTodos') {
            consecutiveGreps = 0;
          }
          results.push(`<tool_result name="${call.function.name}">\n${obsText}\n</tool_result>`);
        }
        messages.push({
          role: 'user',
          content: `[Tool results]\n${results.join('\n\n')}\n\nContinue with the next step using these results. When the task is fully complete, reply with your final answer and DO NOT include any tool tags.`,
        });
      } else {
        // Record the assistant turn (with its native tool calls) then run each tool.
        messages.push({ role: 'assistant', content: contentToString(msg?.content), tool_calls: toolCalls });
        for (const call of toolCalls) {
          if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
          call.function.arguments = resolveToolArgs(call.function.name, call.function.arguments, pathResolver, validateResolvedPath);
          trackToolCall();
          let { observation } = await this.executeToolCall(call, opts, cb);
          const { text: compressedObs, resolver: obsResolver } = compressToolResult(call.function.name, contentToString(observation), call.function.arguments, runOpts?.graph);
          for (const [k, v] of obsResolver) pathResolver.set(k, v);
          if (compressedObs !== contentToString(observation)) observation = compressedObs;
          if (call.function.name === 'grep') {
            consecutiveGreps++;
            try {
              const gArgs = JSON.parse(call.function.arguments) as { pattern?: string };
              if (typeof gArgs.pattern === 'string' && gArgs.pattern.trim().length < 4) {
                observation = `⚠️ Pattern "${gArgs.pattern}" is too short to be a useful search signal. If PRE-RESEARCH in your context already lists file locations, use readFile on those exact files instead. Otherwise grep for a specific function name, class name, or method (4+ characters).`;
              }
            } catch { /* ignore */ }
            if (consecutiveGreps >= 2) {
              const hint = `\n\n⚠️ TOOL LOOP: grep called ${consecutiveGreps}× in a row. STOP grepping. Call readFile on the most relevant file above to get its full content — then use that exact text in your next editFile call.`;
              observation = contentToString(observation) + hint;
            }
          } else if (call.function.name === 'readFile') {
            consecutiveGreps = 0;
            const readArgs = JSON.parse(repairBrokenJson(call.function.arguments)) as { path?: unknown; startLine?: unknown };
            const filePath = String(readArgs.path ?? '');
            if (readArgs.startLine !== undefined) { trackWindowRead(); } else { trackFullFileRead(); }
            if (filePath) {
              const normPath = filePath.replace(/\\/g, '/').toLowerCase();
              const count = (fileReadCount.get(normPath) ?? 0) + 1;
              fileReadCount.set(normPath, count);
              if (count === 1) {
                try {
                  const parsed = JSON.parse(contentToString(observation)) as { content?: string };
                  const syms = extractFileSymbols(parsed?.content ?? '', filePath);
                  if (syms && !fileSummaryCache.has(normPath)) fileSummaryCache.set(normPath, syms);
                } catch { /* best-effort */ }
              }
              if (count >= 2) {
                const syms = fileSummaryCache.get(normPath) ?? '';
                const hint = `\n\n⚠️ FILE LOOP: "${filePath}" read ${count}× — do NOT read again. ${syms ? `Key symbols: ${syms}. ` : ''}If you need a specific section, grep for the function name instead.`;
                observation = contentToString(observation) + hint;
              }
            }
          } else if (call.function.name !== 'think' && call.function.name !== 'updateTodos') {
            consecutiveGreps = 0;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: observation });
        }
      }
    }
    break;
    }
    this.maybeLearnStyle(work());
    // Bench mode must NEVER return a paused stub — a "choose Continue to resume"
    // answer is uncorruptable by the judge and would tank reasoning/answer scores.
    // The 200-iter cap is generous; reaching it means the model is in a loop and
    // should answer with whatever it has so far.
    if (opts.bench) {
      const partial = work().filter((m) => m.role === 'assistant' && typeof m.content === 'string').pop();
      const partialText = typeof partial?.content === 'string' ? partial.content : '_The agent exhausted the benchmark iteration cap before producing an answer._';
      messages.push({ role: 'assistant', content: partialText });
      return { text: partialText, platform: lastPlatform, model: lastModel, workMessages: work(), paused: false };
    }
    return {
      text: "I've paused after a number of steps to check in. I can keep going from here — choose **Continue** and I'll resume where I left off.",
      platform: lastPlatform,
      model: lastModel,
      workMessages: work(),
      paused: true,
    };
  }

  /**
   * Run a single tool call through the shared dispatch (updateTodos / askUser /
   * codebaseSearch / MCP / WorkspaceTools) and emit its UI events. Returns the raw
   * observation — a string for most tools, or a block array for multimodal ones
   * (readImage) — plus its flattened text and whether it looks like an error, so
   * every loop records tool results the same way.
   */
  private async executeToolCall(
    call: ChatToolCall,
    opts: RunOpts,
    cb: AgentCallbacks,
  ): Promise<{ observation: ChatContent; obsText: string; isError: boolean }> {
    let args: unknown;
    // Weak models often emit JSON with markdown fences, trailing commas, or unquoted keys.
    // Repair the raw string first so the call succeeds instead of escalating to a stronger model.
    const argStr = repairBrokenJson(call.function.arguments);
    try { args = JSON.parse(argStr); } catch { args = argStr; }
    cb.onTool?.({ toolCallId: call.id, name: call.function.name, args, state: 'running' });

    // Return cached result for repeated read-only calls within the same run.
    const runDedup = this.dedupFor(opts.runContext?.sessionId ?? '__standalone__');
    // readFile: normalize key to path-only (full-file reads only) so "Helpers.php" and
    // "app/Helpers.php" with different JSON formatting still hit the same cache entry.
    // Windowed reads (startLine/endLine) keep the full args key — their slice varies.
    let dedupKey: string | undefined;
    if (Agent.DEDUP_TOOLS.has(call.function.name)) {
      if (call.function.name === 'readFile') {
        try {
          const ra = JSON.parse(argStr) as { path?: unknown; startLine?: unknown; endLine?: unknown };
          dedupKey = (!ra.startLine && !ra.endLine)
            ? `readFile:path:${String(ra.path ?? '').replace(/\\/g, '/').toLowerCase()}`
            : `${call.function.name}:${argStr}`;
        } catch { dedupKey = `${call.function.name}:${argStr}`; }
      } else {
        dedupKey = `${call.function.name}:${argStr}`;
      }
    }
    if (dedupKey) {
      const hit = runDedup.get(dedupKey);
      if (hit !== undefined) {
        cb.onTool?.({ toolCallId: call.id, name: call.function.name, args, state: 'done', detail: hit.slice(0, 300) });
        return { observation: hit, obsText: hit, isError: false };
      }
    }

    const observation = call.function.name === 'updateTodos'
      ? this.applyTodos(args, cb)
      : call.function.name === 'askUser'
        ? await this.askUser(args, cb)
        : call.function.name === 'codebaseSearch' && this.index
          ? JSON.stringify({ results: await this.index.search(String((args as { query?: unknown })?.query ?? '')) })
          : this.mcp?.isMcpTool(call.function.name)
            ? await this.mcp.callTool(call.function.name, call.function.arguments)
            : await this.tools.execute(call.function.name, argStr, opts.runContext);
    const obsText = contentToString(observation);
    const isError = obsText.includes('"error"');
    if (dedupKey && !isError) runDedup.set(dedupKey, obsText);
    cb.onTool?.({ toolCallId: call.id, name: call.function.name, args, state: isError ? 'error' : 'done', detail: obsText.slice(0, 300) });

    // Failure memory: if a write/edit/patch call fails, record it so the next LLM call
    // knows not to retry the same approach. Cleared at the start of each successful run.
    const WRITE_TOOLS = new Set(['editFile', 'writeFile', 'createFile', 'applyDiff']);
    const sid = opts.runContext?.sessionId ?? '__standalone__';
    if (WRITE_TOOLS.has(call.function.name) && isError) {
      recordFailure(sid, call.function.arguments.slice(0, 200), obsText.slice(0, 100));
    } else if (WRITE_TOOLS.has(call.function.name) && !isError) {
      clearFailure(sid);
    }

    return { observation, obsText, isError };
  }

  /**
   * Chat/Ask mode with web access — a bounded read-only loop that offers ONLY
   * webSearch/webFetch (+ askUser to clarify ambiguity). The model decides whether
   * to search via tool_choice: 'auto': it answers directly for static conceptual
   * questions and calls webSearch for time-sensitive ones (sports, news, prices,
   * weather). This mirrors how Copilot/Kilo/Cline expose a web tool in chat and
   * let the LLM choose — no keyword detection. No file/codebase/edit tools, so chat
   * stays read-only.
   */
  private async runChat(
    history: ChatMessage[],
    system: string,
    opts: RunOpts,
    cb: AgentCallbacks,
  ): Promise<AgentResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];
    const baseLen = messages.length;
    const work = (): ChatMessage[] => messages.slice(baseLen);
    let lastPlatform: string | undefined;
    let lastModel: string | undefined;
    let lastRuntimeName: string | undefined;
    // Just the web tools + askUser. Two tiny specs — negligible token cost per chat turn.
    const tools = [...WEB_TOOL_SPECS, ASK_USER_SPEC];
    const BUDGET = 5; // search → optional fetch → answer (+1 for a refusal correction)
    // A weak model sometimes searches, gets results, then still gives a canned "I only
    // handle code" refusal. Track whether we searched so we can catch that and retry once
    // on a stronger model instead of handing the user an unhelpful non-answer.
    let searched = false;
    let corrected = false;
    let lastPartialText = '';

    for (let i = 0; i < BUDGET; i++) {
      if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
      cb.onStep?.('thinking', 'Working…');
      // Stale out old, large web-search/fetch results so they aren't re-sent every hop.
      trimRunTranscript(messages, baseLen, 1, 800);
      let result: Awaited<ReturnType<Router['route']>>;
      let unhandled: string | undefined;
      try {
        const routed = await this.routeEscalated(messages, {
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          taskKind: 'chat',
          temperature: opts.temperature,
          tools,
          tool_choice: 'auto',
          requireTools: true,
          // After a refusal-correction, demand a stronger model so the retry actually answers.
          maxIntelligenceRank: corrected ? 3 : undefined,
          onFailover: opts.onFailover,
          onKeyRotated: opts.onKeyRotated,
        }, cb);
        result = routed;
      } catch {
        // Chat is best-effort: if the tool-capable model fails, fall back to a plain
        // one-shot answer rather than surfacing an error for a casual question.
        return await this.runSingle(history, system, opts, cb);
      }
      lastPlatform = result.platform;
      lastModel = result.model;
      lastRuntimeName = result.runtimeName;
      cb.onModel?.(result.platform, result.model, result.runtimeName);

      const msg = result.response.choices[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];
      for (const call of toolCalls) {
        if (call.function?.name) call.function.name = sanitizeToolName(call.function.name);
      }
      const chatMsgText = contentToString(msg?.content);
      if (chatMsgText) lastPartialText = chatMsgText;

      if (toolCalls.length === 0) {
        const { reasoning, content } = splitReasoning(chatMsgText);
        // Caught a refusal AFTER a successful search: the model has the results in context
        // but bailed with "I only handle code". Don't ship that — record it, nudge once, and
        // loop again on a stronger model (see maxIntelligenceRank above) to get a real answer.
        if (searched && !corrected && looksLikeCodeRefusal(content)) {
          corrected = true;
          messages.push({ role: 'assistant', content: content || '' });
          messages.push({
            role: 'user',
            content: 'You already searched the web — the results are in the tool output above. Do NOT refuse or say you only handle code; that is wrong here. Answer the original question directly from those results and cite the source URL. If they are insufficient, search again with a better query.',
          });
          continue;
        }
        messages.push({ role: 'assistant', content: content || '_Done._' });
        this.maybeLearnStyle(work());
        return { text: content || '_Done.', reasoning, platform: lastPlatform, model: lastModel, runtimeName: lastRuntimeName, taskKind: 'chat', workMessages: work(), paused: false };
      }
      // Model stuck repeating / can't form valid calls — answer with whatever text it produced.
      if (unhandled) {
        const content = chatMsgText || lastPartialText || "_I couldn't look that up reliably — please try rephrasing._";
        messages.push({ role: 'assistant', content, tool_calls: toolCalls });
        this.maybeLearnStyle(work());
        return { text: content, platform: lastPlatform, model: lastModel, runtimeName: lastRuntimeName, taskKind: 'chat', workMessages: work(), paused: false };
      }
      const stepThought = turnReasoning(msg);
      if (stepThought) cb.onReasoning?.(stepThought);

      messages.push({ role: 'assistant', content: contentToString(msg?.content), tool_calls: toolCalls });
      for (const call of toolCalls) {
        if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
        if (call.function.name === 'webSearch' || call.function.name === 'webFetch') searched = true;
        const { observation } = await this.executeToolCall(call, opts, cb);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: observation });
      }
    }
    // Budget exhausted without a final answer.
    // Use whatever partial text the model produced rather than a canned error.
    this.maybeLearnStyle(work());
    return {
      text: lastPartialText || "_Ran out of steps before finishing. Try a more specific question, or continue this conversation._",
      platform: lastPlatform, model: lastModel, workMessages: work(), paused: false,
    };
  }

}

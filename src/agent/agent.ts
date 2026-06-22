// Agent loop: drives Chat / Plan / Agent modes over the router + tools.
import * as vscode from 'vscode';
import type { ChatContent, ChatMessage, ChatToolCall, Platform, ReasoningEffort, TodoItem } from '../shared/types';
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
import { modeToKind, phaseRouteKind, classifyTask, classifyInformationNeed, informationSourceHint, isCodebaseQuestion, type TaskKind, type TaskProfile } from './routing';
import { classifyInformationRoute } from '../router/informationRouter';
import { runResearchPipeline } from './research';
import { ESCALATION_CAP, isRefusalOrEmpty, toolSignature, allUnparseable } from './escalation';
import { parseTextToolCalls, textToolProtocolPrompt } from './textToolProtocol';
import type { RunContext } from './runContext';
import { unmarkEditing } from './editLock';
import type { RouteOptions } from '../router/router';
import { buildStructuralGraph, loadStructuralGraph, graphSummary } from '../context/structuralGraph';
import { lookupBundle, saveBundle, extractBundleData } from '../context/bundleCache';
import { ExecutionTracker } from '../context/executionMemory';
import { buildExecutionPlan, formatExecutionPlan, formatExecutionPlanVerbose } from '../context/executionPlanner';

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
}

/** Per-run options threaded from the chat provider down to the router. */
export interface RunOpts {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  token?: vscode.CancellationToken;
  taskKind?: TaskKind;
  /** Per-attachment kind on the latest user turn, used to upgrade to a vision-capable model. */
  attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'>;
  /** Pre-task sizing (complexity + intelligence floor) from graph/index signals. Auto only. */
  profile?: TaskProfile;
  /** True when the user left the model on Auto — enables phase routing + auto-escalation. */
  auto?: boolean;
  onFailover?: (i: { from: { platform: string; modelId: string }; reason: string }) => void;
  onKeyRotated?: (i: { platform: string; keyIndex: number; keyTotal: number }) => void;
  /**
   * Session-scoped context for the shared gates: which session's checkpoints to record
   * into, which session's thread to route approvals to, and the live auto-approve read.
   * Omitted for non-chat callers (inline editor chat) → gates use their default behavior.
   */
  runContext?: RunContext;
}

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

  /** Cached project-identity summary, keyed by workspace root (rarely changes mid-session). */
  private groundingCache?: { root: string; text: string };

  /**
   * Per-run deduplication cache: maps "toolName:argStr" → serialized result string.
   * Read-only tools (grep, glob, repoMap, etc.) often get called with the same args
   * multiple times in one agent run — return the cached result instantly instead of
   * re-running the tool call.  Cleared at the top of every run() so stale data never
   * persists across user messages.
   */
  private runDedup = new Map<string, string>();

  private static readonly DEDUP_TOOLS = new Set([
    'grep', 'glob', 'readFile', 'repoMap', 'getDiagnostics', 'codebaseSearch', 'webSearch', 'webFetch',
  ]);

  /**
   * Research Result Persistence: session-level cache of pre-research bundles keyed by
   * search terms. When a follow-up query ("now add API") shares ≥2 terms with a prior
   * query ("add delivery slots" → found StoreController, StoreSchedule), we prepend the
   * prior bundle so the model already knows the relevant files without re-running research.
   * TTL: 10 minutes — long enough for multi-turn tasks, short enough to stay fresh.
   */
  private researchHistory: Array<{ terms: string[]; bundle: string; ts: number }> = [];
  private static readonly RESEARCH_HISTORY_TTL = 10 * 60 * 1000;
  private executionTracker = new ExecutionTracker();

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
    prevSig?: string,
  ): Promise<{ result: Awaited<ReturnType<Router['route']>>; unhandled?: string }> {
    const exclude: string[] = [];
    // Seed the intelligence floor from the caller (e.g. a TaskProfile rankFloor) so the
    // very first hop already respects it; escalation only tightens this further.
    let maxRank = baseOpts.maxIntelligenceRank;
    let last: Awaited<ReturnType<Router['route']>> | undefined;
    for (let hop = 0; hop <= ESCALATION_CAP; hop++) {
      const opts: RouteOptions = {
        ...baseOpts,
        exclude: exclude.length ? exclude : undefined,
        maxIntelligenceRank: maxRank,
      };
      let result: Awaited<ReturnType<Router['route']>>;
      try {
        result = await this.router.route(messages, opts);
      } catch (e) {
        // First hop failing is a genuine "all models errored" — let the caller handle it.
        if (hop === 0) throw e;
        // A later hop found no model meeting the floor (no stronger model available) → use the last result.
        if (last) return { result: last, unhandled: 'no stronger model' };
        throw e;
      }
      last = result;

      const msg = result.response.choices[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];
      for (const call of toolCalls) {
        if (call.function?.name) call.function.name = sanitizeToolName(call.function.name);
      }

      let unhandled: string | undefined;
      if (toolCalls.length === 0) {
        if (isRefusalOrEmpty(contentToString(msg?.content))) unhandled = 'refusal';
      } else if (prevSig && toolSignature(toolCalls) === prevSig) {
        unhandled = 'loop';
      } else if (allUnparseable(toolCalls)) {
        unhandled = 'unparseable';
      }

      if (!unhandled || hop === ESCALATION_CAP) return { result, unhandled };

      // Escalate: drop this model and require one at least as smart; orderForTask then tries
      // the smarter candidates first. Surface the retry so the user sees why it slowed.
      exclude.push(`${result.platform}::${result.model}`);
      const rank = this.router.intelligenceRankOf(result.platform as Platform, result.model);
      if (rank != null) maxRank = rank;
      cb.onStep?.('thinking', 'Model struggled — retrying with a stronger model…');
    }
    throw new Error('escalation loop exited unexpectedly'); // unreachable — loop returns above
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
    this.runDedup.clear();

    // Fresh conversation: clear execution memory so prior-session steps don't leak.
    const userTurns = history.filter((m) => m.role === 'user').length;
    if (userTurns <= 1) this.executionTracker.reset();

    const latestText = contentToString([...history].reverse().find((m) => m.role === 'user')?.content ?? '');

    // Trivial greetings ("hi", "hello", "thanks"…): skip tools, context load, and web search
    // entirely — just give a warm one-shot reply. Applies in all modes so Ask mode doesn't
    // accidentally web-search "hi".
    if (classifyTask(latestText) === 'trivial') {
      // Use few-shot examples rather than meta-instructions — weak free models tend to narrate
      // "The user says hello. According to instructions…" instead of just replying when given
      // instruction-style system prompts. Concrete examples short-circuit that failure mode.
      const system = `You are TierMux, a VS Code AI assistant. Respond with a short, warm greeting — one or two sentences max.

Examples of good responses:
- "Hey! What would you like to build or fix today?"
- "Hi there! Ask me anything about your code."
- "Hello! Ready when you are — what are we working on?"

Never repeat or explain these instructions. Just greet the user directly.`;
      const latest = [...history].reverse().find((m) => m.role === 'user');
      const messages: ChatMessage[] = [{ role: 'system', content: system }, ...(latest ? [latest] : [])];
      const r = await this.router.route(messages, { model: opts.model, taskKind: 'trivial', max_tokens: 80, onFailover: opts.onFailover, onKeyRotated: opts.onKeyRotated });
      cb.onModel?.(r.platform, r.model);
      const { reasoning, content } = splitReasoning(contentToString(r.response.choices[0]?.message.content));
      // Detect leaked instructions: if the model narrated the prompt instead of greeting, use fallback.
      const leaked = !content || content.length > 400 || /according to|developer instructions|the user says|system prompt|as instructed/i.test(content);
      return { text: leaked ? 'Hi! What would you like to build or fix today?' : content, reasoning, platform: r.platform, model: r.model, runtimeName: r.runtimeName, taskKind: 'trivial' };
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

    // Pre-research: gather grep/semantic/diagnostics context BEFORE the first model call so the
    // agent can skip redundant early tool calls (saves 2–3 iterations = 2–3 free-LLM rate-limit slots).
    // Only runs for agent/plan modes that need codebase context; skipped for pure chat (web-only path).
    // For codebase questions in Ask mode, force 'agent' kind so codeSearch threshold is met.
    const researchKind: TaskKind = isCodebaseQ ? 'agent' : routeKind;
    const route = wantsCodeContext ? classifyInformationRoute(latestText, researchKind) : undefined;
    const researchEnabled = route && vscode.workspace.getConfiguration('tiermux.cache').get<boolean>('researchEnabled', true);
    let preResearch = '';
    let preResearchCompact = '';
    let researchFacts: import('../context/researchCompressor').ResearchFacts | undefined;
    let researchRiskLabel: 'low' | 'medium' | 'high' = 'low';

    if (researchEnabled && route) {
      // 1. Check disk bundle cache first (24h TTL, Jaccard ≥ 0.5 match).
      //    Cache hit = zero grep + zero semantic search, instant context.
      const cached = await lookupBundle(route.searchTerms).catch(() => undefined);
      if (cached) {
        preResearch = cached.rawBundle;
      } else {
        // 2. Cache miss → run full pipeline (greps + semantic + symbol + web in parallel).
        const result = await runResearchPipeline(route, this.tools, this.index).catch(() => undefined);
        preResearch = result?.text ?? '';
        preResearchCompact = result?.compactText ?? '';
        researchFacts = result?.facts;
        researchRiskLabel = result?.riskLabel ?? 'low';
        // 3. Save result to disk bundle cache for future queries on the same task.
        if (preResearch && route.searchTerms.length) {
          void saveBundle(extractBundleData(preResearch, route.searchTerms));
        }
      }
    }

    // Research Result Persistence: also check session-level memory (covers last 10 min,
    // supplements the disk cache for very recent follow-up queries in the same session).
    if (route?.searchTerms.length) {
      const prior = this.findPriorResearch(route.searchTerms);
      if (prior && prior !== preResearch) {
        preResearch = prior + (preResearch ? `\n\n---\n\n${preResearch}` : '');
      }
      if (preResearch) this.saveResearch(route.searchTerms, preResearch);
    }

    // Confidence Gate: decide how certain we are about the routing decision.
    //
    //  confidence ≥ 0.5  → normal: we know what to look for, pre-research is solid.
    //  0.35–0.5           → uncertain: pre-research ran but signals were mixed.
    //                       Tell the model to explore more broadly before committing.
    //  < 0.35 + no results → blind: neither code nor web signals fired AND nothing was
    //                       found. Inject a clarification nudge so the model asks ONE
    //                       focused question instead of hallucinating an answer.
    let confidenceHint = '';
    if (route && mode !== 'chat') {
      if (route.confidence < 0.35 && !preResearch) {
        confidenceHint = '\n\n# Low confidence — clarify before acting\n' +
          'Pre-research found nothing and the intent is ambiguous. ' +
          'Use the `askUser` tool to ask ONE focused question (e.g. "Which part of the codebase do you mean?" or "Do you want me to search the code or look it up online?") before proceeding.';
      } else if (route.confidence < 0.5) {
        confidenceHint = '\n\n# Uncertain scope — explore broadly\n' +
          'The request matches mixed signals (code + web, or neither). ' +
          'Run grep/codebaseSearch across more terms before drawing conclusions. ' +
          'Do NOT guess based only on pre-research hints.';
      } else if (researchRiskLabel === 'high' && preResearch) {
        // Semantic confidence is low — matches were weak (stem/fuzzy) or mostly failed.
        // The research block already has an inline HIGH risk comment; reinforce at system level.
        confidenceHint = '\n\n# High truth risk\n' +
          'Research matches were weak (stem or fuzzy). ' +
          'Only state what is directly confirmed by the data. ' +
          'Label inferred parts as "unverified". Prefer using `askUser` over guessing.';
      } else if (researchRiskLabel === 'medium' && preResearch) {
        confidenceHint = '\n\n# Medium truth risk\n' +
          'Some research matches were from fallback queries. ' +
          'State confirmed facts clearly. Mark uncertain parts explicitly.';
      }
    }

    // Response structure hint for "how/explain/what" queries.
    // Weaker free models (Codestral, Mistral) tend to give hedged one-liners when asked
    // an explanatory question — this nudges them to structure the answer like Claude Code would.
    const EXPLAIN_INTENT = /\b(how|explain|describe|what is|what are|where does|how does|how do|tell me|show me how|walk me through|give me|overview of)\b/i;
    if (EXPLAIN_INTENT.test(latestText) && preResearch && mode !== 'chat') {
      confidenceHint += '\n\n# Response format for this explain query\n' +
        'Structure your answer with:\n' +
        '- `## ` headings for each major concept or mechanism\n' +
        '- Bullet points for step-by-step flows or lists\n' +
        '- Inline `file:line` references for every code fact you cite (e.g. `app/Services/ContributionService.php:302`)\n' +
        '- A short **Summary** section at the end\n' +
        'Do not hedge or say "I couldn\'t find" if the pre-research above contains the answer.';
    }

    // Pre-Execution Plan: build a dependency-ordered checklist from research facts.
    // Injected BEFORE research details so the model reads "what to do" before "where to look".
    // Only fires for agent/plan modes on code tasks with enough signal (null = skip).
    const plan = researchFacts && route && mode !== 'chat'
      ? buildExecutionPlan(researchFacts, route, latestText)
      : null;

    // Progressive context selection:
    //   High-confidence (≥ 0.7) + plan ready:
    //     → compact XML plan (~40t) + compact context tag (~25t)
    //     → skip raw grep/semantic/hop details (plan already lists every file)
    //     → saves ~600-900 tokens on routine tasks
    //   Low-confidence (< 0.7) or no plan:
    //     → verbose plan + full research details (grep output helps the model explore)
    const highConfidence = plan !== null && (plan?.confidence ?? 0) >= 0.7;
    const planBlock = plan
      ? (highConfidence ? formatExecutionPlan(plan) : formatExecutionPlanVerbose(plan))
      : '';
    const researchBlock = highConfidence && preResearchCompact
      ? preResearchCompact   // compact XML tag only — raw details omitted
      : preResearch;         // full understanding block + raw grep/semantic/hop sections

    const executionContext = this.executionTracker.buildContextBlock();
    const withResearch = (base: string): string =>
      base
      + (planBlock ? `\n\n${planBlock}` : '')
      + (executionContext ? `\n\n${executionContext}` : '')
      + (researchBlock ? `\n\n${researchBlock}` : '')
      + confidenceHint;

    let result: AgentResult;
    try {
      if (mode === 'chat') {
        const webOn = vscode.workspace.getConfiguration('tiermux.tools').get<boolean>('web', true);
        if (isCodebaseQ) {
          // Codebase question in Ask mode: read-only agent with code tools (grep/readFile/repoMap…)
          // and full project grounding — same posture as Plan mode, no edits allowed.
          const askCodeSystem = withResearch(augment(CHAT_SYSTEM) + infoHint);
          result = await this.runAgent(augmented, askCodeSystem, ropts, cb, { readOnly: true });
        } else {
          // Pure Ask: web-only path — no code tools, no grounding.
          result = webOn
            ? await this.runChat(augmented, augment(CHAT_SYSTEM), ropts, cb)
            : await this.runSingle(augmented, augment(CHAT_SYSTEM), ropts, cb);
        }
      } else if (mode === 'plan') {
        // Plan: research the codebase read-only, then propose a plan for approval.
        result = await this.runAgent(augmented, withResearch(augment(PLAN_SYSTEM)), ropts, cb, { readOnly: true });
      } else {
        // Agent: full tool access — reads, edits, runs commands.
        result = await this.runAgent(augmented, withResearch(augment(AGENT_SYSTEM) + infoHint), ropts, cb);
      }
    } finally {
      // Release this run's edit-advisory claims whether it finished, failed, or was cancelled,
      // so a subsequent run isn't falsely told the files are still being edited.
      unmarkEditing(opts.runContext?.requestId);
    }
    result.taskKind = routeKind;
    // Record tool calls so the next run knows what was already done this session.
    if (result.workMessages?.length) {
      this.executionTracker.record(result.workMessages as Array<{ role?: string; content?: unknown }>);
    }
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
    const { result } = await this.routeEscalated(messages, {
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      taskKind: opts.taskKind,
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
    runOpts?: { readOnly?: boolean; weak?: boolean },
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
    const toolsFiltered = tools.filter((t) => !runOpts?.readOnly || READONLY_TOOLS.has(t.function.name));
    // Teach weak models the XML text tool-protocol so they can ACT even when the provider
    // ignores native function-calling — the dominant "replies with prose, never edits" failure.
    // Strong models keep native calling untouched; the parser below is a harmless safety net.
    if (weak) messages[0] = { role: 'system', content: `${system}\n\n${textToolProtocolPrompt(toolsFiltered)}` };
    let prevSig = '';
    // Auto orchestration (strong models only): phase routing (reason → execute) and a bounded
    // auto-escalation past the step cap. Weak free models get a SIMPLE single-model path instead
    // — phase switching and extra escalation batches hurt them (they can't hand off context well,
    // and re-sending the growing history burns their tiny free-tier budget).
    const auto = !!opts.auto && !weak;
    const baseKind = opts.taskKind ?? 'agent';
    const baseBudget = this.maxIterations();
    const ESCALATION_BATCH = 8; // max extra iterations per auto-escalation
    const hardCeiling = auto ? baseBudget + ESCALATION_BATCH : baseBudget;
    const AUTO_ESCALATE_CAP = 1; // one automatic escalation beyond the base budget
    let floor = auto ? (opts.profile?.rankFloor ?? 4) : undefined;
    let totalIter = 0;
    let level = 0;
    // Consecutive grep counter: if the model greps 3+ times in a row without a readFile,
    // append a strong hint to the next grep result to break the loop.
    // This is the primary cause of 400+ second hangs on free LLMs after editFile fails.
    let consecutiveGreps = 0;

    while (totalIter < hardCeiling) {
      // First batch = the normal budget; an escalation batch is short (ESCALATION_BATCH).
      const phaseBudget = Math.min(hardCeiling - totalIter, level === 0 ? baseBudget : ESCALATION_BATCH);
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
      // Phase routing (Auto, strong only): the first hop reasons/plans, then the classified
      // execute kind takes over. Weak models keep one stable kind for the whole run.
      const phaseKind = auto ? phaseRouteKind(baseKind, totalIter) : baseKind;
      let result: Awaited<ReturnType<Router['route']>>;
      let unhandled: string | undefined;
      try {
        const routed = await this.routeEscalated(messages, {
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          taskKind: phaseKind,
          tools: toolsFiltered,
          tool_choice: 'auto',
          requireTools: true,
          maxIntelligenceRank: floor,
          onFailover: opts.onFailover,
      onKeyRotated: opts.onKeyRotated,
        }, cb, prevSig);
        result = routed.result;
        unhandled = routed.unhandled;
      } catch (e) {
        // Free models frequently drop out mid-task. If we've already made progress, pause
        // and hand back the work so far so the user can resume; if it failed on the very
        // first call (no progress yet), surface the error through the normal path.
        if (messages.length > baseLen) {
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

      if (toolCalls.length === 0) {
        const { reasoning, content } = splitReasoning(contentToString(msg?.content));
        // Record the final answer so it's part of the persisted transcript too.
        messages.push({ role: 'assistant', content: content || '_Done._' });
        this.maybeLearnStyle(work());
        return { text: content || '_Done._', reasoning, platform: lastPlatform, model: lastModel, runtimeName: lastRuntimeName, workMessages: work(), paused: false };
      }

      // `unhandled` is the NATIVE escalation verdict (stuck loop / garbage args from a stronger
      // model). A successful text-protocol parse means the model actually acted, so it doesn't
      // apply — only bail here when we're NOT in text mode.
      if (unhandled && !textMode) {
        messages.push({ role: 'assistant', content: contentToString(msg?.content) || '_The model could not make progress._', tool_calls: toolCalls });
        this.maybeLearnStyle(work());
        return {
          text: "⚠️ I'm stuck — the model kept repeating itself or couldn't form valid tool calls, even after retrying with a stronger model. Choose **Continue** to try again, or rephrase the task.",
          platform: lastPlatform, model: lastModel, workMessages: work(), paused: true,
        };
      }

      // Text-mode loop guard: routeEscalated only compares NATIVE calls, so a weak model
      // repeating the same XML block verbatim would otherwise burn iterations to the cap.
      const curSig = toolSignature(toolCalls);
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
          let { obsText } = await this.executeToolCall(call, opts, cb);
          if (call.function.name === 'grep') {
            consecutiveGreps++;
            if (consecutiveGreps >= 3) {
              obsText += `\n\n⚠️ TOOL LOOP: grep called ${consecutiveGreps}× in a row. STOP grepping. Call readFile on the most relevant file above to get its full content — then use that exact text in your next editFile call.`;
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
          let { observation } = await this.executeToolCall(call, opts, cb);
          if (call.function.name === 'grep') {
            consecutiveGreps++;
            if (consecutiveGreps >= 3) {
              const hint = `\n\n⚠️ TOOL LOOP: grep called ${consecutiveGreps}× in a row. STOP grepping. Call readFile on the most relevant file above to get its full content — then use that exact text in your next editFile call.`;
              observation = contentToString(observation) + hint;
            }
          } else if (call.function.name !== 'think' && call.function.name !== 'updateTodos') {
            consecutiveGreps = 0;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: observation });
        }
      }
    }
    // Budget exhausted without finishing. Auto escalates to a stronger model and continues;
    // everything else (or once the escalation cap / hard ceiling is reached) pauses for the user.
    if (auto && level < AUTO_ESCALATE_CAP && totalIter < hardCeiling) {
      level++;
      floor = Math.max(1, (floor ?? 4) - 1);
      cb.onStep?.('thinking', 'Still working — escalating to a stronger model to finish…');
      // Safe to append: the transcript ends on tool results, so a user turn here mirrors resume.
      messages.push({ role: 'user', content: 'Continue from where you left off. Keep going with the remaining steps using the work already done above — do not restart or repeat completed steps.' });
      continue;
    }
    break;
    }
    this.maybeLearnStyle(work());
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
    const dedupKey = Agent.DEDUP_TOOLS.has(call.function.name) ? `${call.function.name}:${argStr}` : undefined;
    if (dedupKey) {
      const hit = this.runDedup.get(dedupKey);
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
    if (dedupKey && !isError) this.runDedup.set(dedupKey, obsText);
    cb.onTool?.({ toolCallId: call.id, name: call.function.name, args, state: isError ? 'error' : 'done', detail: obsText.slice(0, 300) });
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
    let prevSig = '';
    // A weak model sometimes searches, gets results, then still gives a canned "I only
    // handle code" refusal. Track whether we searched so we can catch that and retry once
    // on a stronger model instead of handing the user an unhelpful non-answer.
    let searched = false;
    let corrected = false;

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
          tools,
          tool_choice: 'auto',
          requireTools: true,
          // After a refusal-correction, demand a stronger model so the retry actually answers.
          maxIntelligenceRank: corrected ? 3 : undefined,
          onFailover: opts.onFailover,
      onKeyRotated: opts.onKeyRotated,
        }, cb, prevSig);
        result = routed.result;
        unhandled = routed.unhandled;
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

      if (toolCalls.length === 0) {
        const { reasoning, content } = splitReasoning(contentToString(msg?.content));
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
        const content = contentToString(msg?.content) || "_I couldn't look that up reliably — please try rephrasing._";
        messages.push({ role: 'assistant', content, tool_calls: toolCalls });
        this.maybeLearnStyle(work());
        return { text: content, platform: lastPlatform, model: lastModel, runtimeName: lastRuntimeName, taskKind: 'chat', workMessages: work(), paused: false };
      }
      prevSig = toolSignature(toolCalls);

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
    // Budget exhausted without a final answer — return the last model/text we have.
    this.maybeLearnStyle(work());
    return {
      text: "_I couldn't finish looking that up. Try rephrasing, or switch to Agent mode for a deeper search._",
      platform: lastPlatform, model: lastModel, taskKind: 'chat', workMessages: work(), paused: false,
    };
  }

}

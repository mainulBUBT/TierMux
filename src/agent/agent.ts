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
import { AGENT_SYSTEM, AGENT_SYSTEM_LITE, CHAT_SYSTEM, PLAN_SYSTEM, DEBUG_SYSTEM, ORCHESTRATOR_SYSTEM, RESPONSIBILITY_RULES } from './prompts';
import { loadProjectRules } from '../context/projectRules';
import { loadUserMemory, inferStyleFromEdits, upsertLearnedSection } from '../context/userMemory';
import { loadProjectGrounding } from '../context/projectGrounding';
import { buildAmbientContext } from '../context/ambient';
import { classifyTask, modeToKind, phaseRouteKind, deriveTaskProfile, isCodebaseQuestion, type TaskKind, type TaskProfile } from './routing';
import { ESCALATION_CAP, isRefusalOrEmpty, toolSignature, allUnparseable } from './escalation';
import { PRODUCT_NAME } from '../shared/branding';
import type { RunContext } from './runContext';
import { unmarkEditing } from './editLock';
import type { RouteOptions } from '../router/router';
import { buildStructuralGraph, loadStructuralGraph, graphSummary } from '../context/structuralGraph';
import { analyzeImpact } from '../context/impactAnalysis';

export type Mode = 'auto' | 'chat' | 'plan' | 'agent' | 'debug' | 'orchestrator';

/** Max subtasks an Orchestrator run will decompose into (bounds free-tier cost). */
const MAX_SUBTASKS = 6;
/** Prepended for read-only codebase Q&A: investigate with search/read/graph tools, then explain. */
const RESEARCH_DIRECTIVE = '\n\n# Mode: read-only research\nThe user is asking about this codebase. Use the read/search/graph tools to investigate the actual code, then give a clear, accurate explanation with file references. Do NOT edit, create, or delete any files.';

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
  onModel?: (platform: string, model: string) => void;
  onTool?: (event: ToolEvent) => void;
  /** Coarse phase signal for the live "agent is working" status line. */
  onStep?: (phase: 'thinking' | 'synthesizing' | 'done', label: string) => void;
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

export class Agent {
  constructor(
    private readonly router: Router,
    private readonly tools: WorkspaceTools,
    private readonly mcp?: McpManager,
    private readonly index?: CodebaseIndex,
  ) {}

  /** Cached project-identity summary, keyed by workspace root (rarely changes mid-session). */
  private groundingCache?: { root: string; text: string };

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
    // Show the "Thinking…" indicator immediately — before grounding/context prep and
    // the (slow, free-tier) model call — so the UI never looks frozen while waiting.
    cb.onStep?.('thinking', 'Thinking…');

    // Classify the latest user message once; drives both mode (in Auto) and model routing.
    const latestText = contentToString([...history].reverse().find((m) => m.role === 'user')?.content ?? '');
    const kind = classifyTask(latestText, opts.attachmentKinds && opts.attachmentKinds.length > 0
      ? { attachments: opts.attachmentKinds.length, attachmentKinds: opts.attachmentKinds }
      : undefined);

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

    // Auto: a trivial greeting gets a cheap, context-light reply — no tools, no
    // grounding dump, no prior-task history. This is what stops "hello" burning tokens.
    if (mode === 'auto' && kind === 'trivial') {
      const r = await this.runTrivial(history, opts, cb);
      r.taskKind = 'trivial';
      return r;
    }

    // Capability of the likely model decides scaffolding. Weak free models (low intelligence
    // rank or no reasoning) get a CONSTRAINED path — core tools + compact prompt + single model —
    // so they succeed instead of flailing on 17 tools and long prompts. Strong models keep the
    // full toolset + orchestration.
    const isAuto = mode === 'auto';
    const cap = this.router.topModelProfile();
    const weak = isAuto && !!cap && (cap.intelligenceRank >= 4 || !cap.supportsReasoning);

    // Cline-style unify: every non-trivial Auto message goes through the tool loop. The model
    // decides whether to investigate (it can also just answer). Read-only unless there's real
    // edit intent — so questions/research investigate with safe tools, never editing by accident.
    const writableKind = kind === 'agent' || kind === 'coding' || kind === 'debug';
    const routeKind: TaskKind = isAuto ? kind : modeToKind(mode);
    // Adaptive context: a question that isn't about the codebase (general/web/factual — e.g.
    // "today's FIFA match?") doesn't need the repo map, open-editor dump, or auto-retrieved code
    // chunks. Skipping them for those cuts a ~48k prompt down to a few k. Code tasks and repo
    // questions keep full context.
    const wantsCodeContext = kind !== 'chat' || isCodebaseQuestion(latestText);
    // Scoping/phase-routing only helps strong writable tasks; skip it (and its overhead) otherwise.
    const needsProfile = isAuto && !weak && writableKind;
    const profile = needsProfile ? await this.scopeRun(latestText) : undefined;
    const ropts: RunOpts = { ...opts, taskKind: routeKind, auto: isAuto, profile };

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
    let result: AgentResult;
    try {
      if (isAuto) {
        // Auto = unified tool loop (Cline-style). Read-only for questions, writable for edits.
        // Weak models get the compact prompt; strong models get the full one (+ research nudge
        // when read-only). The model may answer directly without tools for pure knowledge questions.
        const readOnly = !writableKind;
        const base = weak ? AGENT_SYSTEM_LITE : AGENT_SYSTEM;
        const system = augment(base) + (!weak && readOnly ? RESEARCH_DIRECTIVE : '');
        result = await this.runAgent(augmented, system, ropts, cb, { readOnly, weak });
      } else if (mode === 'chat') {
        // Explicit Ask mode: bounded read-only web loop when web tools are on, else cheap one-shot.
        const webOn = vscode.workspace.getConfiguration('tiermux.tools').get<boolean>('web', true);
        result = webOn
          ? await this.runChat(augmented, augment(CHAT_SYSTEM), ropts, cb)
          : await this.runSingle(augmented, augment(CHAT_SYSTEM), ropts, cb);
      }
      else if (mode === 'plan') result = await this.runAgent(augmented, augment(PLAN_SYSTEM), ropts, cb, { readOnly: true });
      else if (mode === 'debug') result = await this.runAgent(augmented, augment(DEBUG_SYSTEM), ropts, cb);
      else if (mode === 'orchestrator') result = await this.runOrchestrator(augmented, augment(AGENT_SYSTEM), augment(ORCHESTRATOR_SYSTEM), ropts, cb);
      else result = await this.runAgent(augmented, augment(AGENT_SYSTEM), ropts, cb);
    } finally {
      // Release this run's edit-advisory claims whether it finished, failed, or was cancelled,
      // so a subsequent run isn't falsely told the files are still being edited.
      unmarkEditing(opts.runContext?.requestId);
    }
    result.taskKind = routeKind;
    return result;
  }

  /** Cheap path for greetings / small talk: tiny prompt, fast model, latest turn only, capped output. */
  private async runTrivial(history: ChatMessage[], opts: RunOpts, cb: AgentCallbacks): Promise<AgentResult> {
    const system = `You are ${PRODUCT_NAME}, a friendly AI coding assistant in VS Code. Reply to the user's greeting or small talk warmly and in one short sentence, then invite them to tell you what they'd like to build or fix. Do not analyze the project, run steps, or write long explanations.`;
    const latest = [...history].reverse().find((m) => m.role === 'user');
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...(latest ? [latest] : [])];
    cb.onStep?.('thinking', 'Thinking…');
    const result = await this.router.route(messages, {
      model: opts.model,
      taskKind: 'trivial',
      max_tokens: 200,
      onFailover: opts.onFailover,
    });
    cb.onModel?.(result.platform, result.model);
    const { reasoning, content } = splitReasoning(contentToString(result.response.choices[0]?.message.content));
    return { text: content || 'Hi! What would you like to build or fix today?', reasoning, platform: result.platform, model: result.model };
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

  /**
   * One-shot task sizing for Auto: estimate impact breadth from the code graph (how many
   * files a change to the mentioned paths would touch) and novelty from the embeddings index
   * (top similarity — low means the task is uncharted/harder). Both are best-effort and null
   * when their source is off/unavailable; deriveTaskProfile falls back to `moderate`.
   */
  private async scopeRun(text: string): Promise<TaskProfile> {
    const mentions = Array.from(new Set(
      (text.match(/\b[\w-]+(?:\/[\w-]+)*\.[a-zA-Z]{1,5}\b/g) ?? [])
        .map((s) => s.trim()).filter((s) => s.length > 2),
    )).slice(0, 5);
    let impactFiles: number | null = null;
    let topSimilarity: number | null = null;
    const graphOn = vscode.workspace.getConfiguration('tiermux.graph').get<boolean>('enabled', false);
    if (graphOn && mentions.length) {
      try {
        const graph = await loadStructuralGraph();
        if (graph) impactFiles = analyzeImpact(graph, mentions).impacted.length;
      } catch { /* best-effort */ }
    }
    if (this.index && this.index.isEnabled() && this.index.hasIndex()) {
      try {
        const results = await this.index.search(text.slice(0, 2000), 1);
        topSimilarity = results.length ? results[0].score : 0;
      } catch { /* best-effort */ }
    }
    return deriveTaskProfile(impactFiles, topSimilarity);
  }

  /** One-shot completion (chat or plan): no tools. */
  private async runSingle(
    history: ChatMessage[],
    system: string,
    opts: RunOpts,
    cb: AgentCallbacks,
  ): Promise<AgentResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];
    cb.onStep?.('thinking', 'Thinking…');
    const { result } = await this.routeEscalated(messages, {
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      taskKind: opts.taskKind,
      onFailover: opts.onFailover,
    }, cb);
    cb.onModel?.(result.platform, result.model);
    const raw = contentToString(result.response.choices[0]?.message.content);
    const { reasoning, content } = splitReasoning(raw);
    return { text: content, reasoning, platform: result.platform, model: result.model };
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

    while (totalIter < hardCeiling) {
      // First batch = the normal budget; an escalation batch is short (ESCALATION_BATCH).
      const phaseBudget = Math.min(hardCeiling - totalIter, level === 0 ? baseBudget : ESCALATION_BATCH);
      for (let i = 0; i < phaseBudget; i++, totalIter++) {
      // Cancel = stop, not pause: don't persist a partial transcript (it could end on an
      // assistant tool_calls turn with no tool results, which would break the next request).
      if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };

      cb.onStep?.('thinking', 'Thinking…');
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
      cb.onModel?.(result.platform, result.model);

      const msg = result.response.choices[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];
      // Clean any leaked Harmony/control tokens from tool names (e.g. gpt-oss emits
      // `searchWorkspace<|channel|>commentary`) so calls resolve and history stays consistent.
      for (const call of toolCalls) {
        if (call.function?.name) call.function.name = sanitizeToolName(call.function.name);
      }

      if (toolCalls.length === 0) {
        const { reasoning, content } = splitReasoning(contentToString(msg?.content));
        // Record the final answer so it's part of the persisted transcript too.
        messages.push({ role: 'assistant', content: content || '_Done._' });
        this.maybeLearnStyle(work());
        return { text: content || '_Done._', reasoning, platform: lastPlatform, model: lastModel, workMessages: work(), paused: false };
      }

      // Escalation exhausted but the model still can't form usable tool calls (stuck loop or
      // garbage args even from a stronger model) — stop gracefully instead of executing junk.
      if (unhandled) {
        messages.push({ role: 'assistant', content: contentToString(msg?.content) || '_The model could not make progress._', tool_calls: toolCalls });
        this.maybeLearnStyle(work());
        return {
          text: "⚠️ I'm stuck — the model kept repeating itself or couldn't form valid tool calls, even after retrying with a stronger model. Choose **Continue** to try again, or rephrase the task.",
          platform: lastPlatform, model: lastModel, workMessages: work(), paused: true,
        };
      }
      prevSig = toolSignature(toolCalls);

      // Record the assistant turn (with its tool calls) then run each tool.
      messages.push({ role: 'assistant', content: contentToString(msg?.content), tool_calls: toolCalls });
      for (const call of toolCalls) {
        if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
        const { observation } = await this.executeToolCall(call, opts, cb);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: observation });
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
    // Just the web tools + askUser. Two tiny specs — negligible token cost per chat turn.
    const tools = [...WEB_TOOL_SPECS, ASK_USER_SPEC];
    const BUDGET = 4; // search → optional fetch → answer
    let prevSig = '';

    for (let i = 0; i < BUDGET; i++) {
      if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
      cb.onStep?.('thinking', 'Thinking…');
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
          onFailover: opts.onFailover,
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
      cb.onModel?.(result.platform, result.model);

      const msg = result.response.choices[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];
      for (const call of toolCalls) {
        if (call.function?.name) call.function.name = sanitizeToolName(call.function.name);
      }

      if (toolCalls.length === 0) {
        const { reasoning, content } = splitReasoning(contentToString(msg?.content));
        messages.push({ role: 'assistant', content: content || '_Done._' });
        this.maybeLearnStyle(work());
        return { text: content || '_Done.', reasoning, platform: lastPlatform, model: lastModel, taskKind: 'chat', workMessages: work(), paused: false };
      }
      // Model stuck repeating / can't form valid calls — answer with whatever text it produced.
      if (unhandled) {
        const content = contentToString(msg?.content) || "_I couldn't look that up reliably — please try rephrasing._";
        messages.push({ role: 'assistant', content, tool_calls: toolCalls });
        this.maybeLearnStyle(work());
        return { text: content, platform: lastPlatform, model: lastModel, taskKind: 'chat', workMessages: work(), paused: false };
      }
      prevSig = toolSignature(toolCalls);

      messages.push({ role: 'assistant', content: contentToString(msg?.content), tool_calls: toolCalls });
      for (const call of toolCalls) {
        if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
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

  /** Orchestrator mode: decompose the task into subtasks, then run each as a fresh agent step. */
  private async runOrchestrator(
    history: ChatMessage[],
    agentSystem: string,
    decomposeSystem: string,
    opts: RunOpts,
    cb: AgentCallbacks,
  ): Promise<AgentResult> {
    // 1. Decompose the request into an ordered subtask list.
    let subtasks: string[] = [];
    try {
      const res = await this.router.route([{ role: 'system', content: decomposeSystem }, ...history], {
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        taskKind: opts.taskKind ?? 'agent',
        onFailover: opts.onFailover,
      });
      cb.onModel?.(res.platform, res.model);
      subtasks = parseSubtasks(contentToString(res.response.choices[0]?.message.content)).slice(0, MAX_SUBTASKS);
    } catch { /* fall back to a plain agent run below */ }

    // Nothing useful to orchestrate → behave like a normal agent.
    if (subtasks.length <= 1) return this.runAgent(history, agentSystem, opts, cb);

    const originalTask = contentToString([...history].reverse().find((m) => m.role === 'user')?.content ?? '');
    const summaries: string[] = [];
    let lastPlatform: string | undefined;
    let lastModel: string | undefined;

    // 2. Execute each subtask as a fresh, focused agent run, threading progress forward.
    for (let i = 0; i < subtasks.length; i++) {
      if (opts.token?.isCancellationRequested) break;
      const stepArgs = { step: i + 1, of: subtasks.length, task: subtasks[i] };
      cb.onTool?.({ toolCallId: `step-${i}`, name: 'step', args: stepArgs, state: 'running' });
      const progress = summaries.length
        ? `Progress so far:\n${summaries.map((s, j) => `- Step ${j + 1} (${subtasks[j]}): ${s}`).join('\n')}\n\n`
        : '';
      const subPrompt = `${progress}You are completing ONE step of a larger task.\nOverall task: ${originalTask}\n\nYour step now — step ${i + 1} of ${subtasks.length}: ${subtasks[i]}\n\nComplete just this step, then stop.`;
      const sub = await this.runAgent([{ role: 'user', content: subPrompt }], agentSystem, opts, cb);
      lastPlatform = sub.platform ?? lastPlatform;
      lastModel = sub.model ?? lastModel;
      const summary = sub.text.replace(/\s+/g, ' ').slice(0, 400);
      summaries.push(summary);
      cb.onTool?.({ toolCallId: `step-${i}`, name: 'step', args: stepArgs, state: 'done', detail: summary });
    }

    // 3. Consolidated report.
    const body = subtasks
      .map((st, i) => `**Step ${i + 1}: ${st}**\n\n${summaries[i] ?? '_(not run)_'}`)
      .join('\n\n');
    return {
      text: `Completed ${summaries.length} of ${subtasks.length} orchestrated steps.\n\n${body}`,
      platform: lastPlatform,
      model: lastModel,
    };
  }
}

/** Parse an Orchestrator decomposition: a JSON array of strings, with a numbered/bulleted fallback. */
function parseSubtasks(text: string): string[] {
  const t = (text || '').trim();
  const arrMatch = t.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      if (Array.isArray(arr)) return arr.map((s) => String(s).trim()).filter(Boolean);
    } catch { /* fall through to line parsing */ }
  }
  return t
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter((l) => l.length > 0 && !/^```/.test(l));
}

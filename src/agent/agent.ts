// Agent loop: drives Chat / Plan / Agent modes over the router + tools.
import * as vscode from 'vscode';
import type { ChatMessage, ReasoningEffort, TodoItem } from '../shared/types';
import type { Router } from '../router/router';
import type { WorkspaceTools, ToolEvent } from './tools';
import type { McpManager } from '../mcp/mcpManager';
import type { CodebaseIndex } from '../index/codebaseIndex';
import { contentToString } from './content';
import { sanitizeToolName } from './toolArgs';
import { TOOL_SPECS, CODEBASE_SEARCH_SPEC } from './toolSpecs';
import { AGENT_SYSTEM, CHAT_SYSTEM, PLAN_SYSTEM, DEBUG_SYSTEM, ORCHESTRATOR_SYSTEM } from './prompts';
import { loadProjectRules } from '../context/projectRules';
import { loadProjectGrounding } from '../context/projectGrounding';
import { buildAmbientContext } from '../context/ambient';
import { classifyTask, modeToKind, type TaskKind } from './routing';
import { PRODUCT_NAME } from '../shared/branding';

export type Mode = 'auto' | 'chat' | 'plan' | 'agent' | 'debug' | 'orchestrator';

/** Max subtasks an Orchestrator run will decompose into (bounds free-tier cost). */
const MAX_SUBTASKS = 6;

/**
 * Tools Plan mode is allowed to use — strictly read-only, so it can research the
 * codebase without ever mutating it. Filtering the full tool list by this set also
 * drops mutating built-ins (write/create/edit/delete/runCommand) and all MCP tools,
 * whose side-effects are unknown.
 */
const READONLY_TOOLS = new Set([
  'readFile', 'listDir', 'repoMap', 'searchWorkspace', 'getDiagnostics', 'codebaseSearch',
]);

export interface AgentCallbacks {
  onModel?: (platform: string, model: string) => void;
  onTool?: (event: ToolEvent) => void;
  /** Coarse phase signal for the live "agent is working" status line. */
  onStep?: (phase: 'thinking' | 'synthesizing' | 'done', label: string) => void;
  /** Live task checklist updates (the agent's updateTodos calls). */
  onTodos?: (todos: TodoItem[]) => void;
}

/** Per-run options threaded from the chat provider down to the router. */
export interface RunOpts {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  token?: vscode.CancellationToken;
  taskKind?: TaskKind;
  onFailover?: (i: { from: { platform: string; modelId: string }; reason: string }) => void;
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
    const kind = classifyTask(latestText);

    // Auto: a trivial greeting gets a cheap, context-light reply — no tools, no
    // grounding dump, no prior-task history. This is what stops "hello" burning tokens.
    if (mode === 'auto' && kind === 'trivial') {
      const r = await this.runTrivial(history, opts, cb);
      r.taskKind = 'trivial';
      return r;
    }

    // Resolve the concrete behavior and the task kind used for model routing.
    const resolved: Exclude<Mode, 'auto'> =
      mode !== 'auto' ? mode : kind === 'agent' ? 'agent' : kind === 'debug' ? 'debug' : 'chat';
    const routeKind: TaskKind = mode === 'auto' ? kind : modeToKind(mode);
    const ropts: RunOpts = { ...opts, taskKind: routeKind };

    const [rules, grounding] = await Promise.all([loadProjectRules(), this.grounding()]);
    const augment = (base: string): string => {
      let s = base;
      if (grounding) s += `\n\n# Project context (orient yourself here first)\n${grounding}`;
      if (rules) s += `\n\n# Project rules (follow these)\n${rules}`;
      return s;
    };
    const augmented = await this.prepareContext(history);
    let result: AgentResult;
    if (resolved === 'chat') result = await this.runSingle(augmented, augment(CHAT_SYSTEM), ropts, cb);
    else if (resolved === 'plan') result = await this.runAgent(augmented, augment(PLAN_SYSTEM), ropts, cb, { readOnly: true });
    else if (resolved === 'debug') result = await this.runAgent(augmented, augment(DEBUG_SYSTEM), ropts, cb);
    else if (resolved === 'orchestrator') result = await this.runOrchestrator(augmented, augment(AGENT_SYSTEM), augment(ORCHESTRATOR_SYSTEM), ropts, cb);
    else result = await this.runAgent(augmented, augment(AGENT_SYSTEM), ropts, cb);
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

  /** Insert a context turn (ambient editor context + auto-retrieved code) before the latest user message. */
  private async prepareContext(history: ChatMessage[]): Promise<ChatMessage[]> {
    const blocks: string[] = [];
    const ambient = buildAmbientContext();
    if (ambient) blocks.push(`Editor context:\n${ambient}`);
    const retrieved = await this.retrieve(history);
    if (retrieved) blocks.push(retrieved);
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
    cb.onStep?.('thinking', 'Thinking…');
    const result = await this.router.route(messages, {
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      taskKind: opts.taskKind,
      onFailover: opts.onFailover,
    });
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
    runOpts?: { readOnly?: boolean },
  ): Promise<AgentResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];
    // Everything appended past this prefix is the agent's working transcript; it's
    // returned as workMessages so a paused/failed run can resume with full memory.
    const baseLen = messages.length;
    const work = (): ChatMessage[] => messages.slice(baseLen);
    let lastPlatform: string | undefined;
    let lastModel: string | undefined;

    if (this.mcp && !runOpts?.readOnly) { try { await this.mcp.ensureStarted(); } catch { /* MCP optional */ } }
    const indexOn = !!this.index && this.index.isEnabled() && this.index.hasIndex();
    const tools = [
      ...TOOL_SPECS,
      ...(indexOn ? [CODEBASE_SEARCH_SPEC] : []),
      ...(runOpts?.readOnly ? [] : this.mcp?.listToolSpecs() ?? []),
    ].filter((t) => !runOpts?.readOnly || READONLY_TOOLS.has(t.function.name));

    for (let i = 0; i < this.maxIterations(); i++) {
      // Cancel = stop, not pause: don't persist a partial transcript (it could end on an
      // assistant tool_calls turn with no tool results, which would break the next request).
      if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };

      cb.onStep?.('thinking', 'Thinking…');
      let result: Awaited<ReturnType<Router['route']>>;
      try {
        result = await this.router.route(messages, {
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          taskKind: opts.taskKind,
          tools,
          tool_choice: 'auto',
          requireTools: true,
          onFailover: opts.onFailover,
        });
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
        return { text: content || '_Done._', reasoning, platform: lastPlatform, model: lastModel, workMessages: work(), paused: false };
      }

      // Record the assistant turn (with its tool calls) then run each tool.
      messages.push({ role: 'assistant', content: contentToString(msg?.content), tool_calls: toolCalls });
      for (const call of toolCalls) {
        if (opts.token?.isCancellationRequested) return { text: '_Cancelled._', platform: lastPlatform, model: lastModel };
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); } catch { args = call.function.arguments; }
        cb.onTool?.({ toolCallId: call.id, name: call.function.name, args, state: 'running' });
        const observation = call.function.name === 'updateTodos'
          ? this.applyTodos(args, cb)
          : call.function.name === 'codebaseSearch' && this.index
            ? JSON.stringify({ results: await this.index.search(String((args as { query?: unknown })?.query ?? '')) })
            : this.mcp?.isMcpTool(call.function.name)
              ? await this.mcp.callTool(call.function.name, call.function.arguments)
              : await this.tools.execute(call.function.name, call.function.arguments);
        const isError = observation.includes('"error"');
        cb.onTool?.({ toolCallId: call.id, name: call.function.name, args, state: isError ? 'error' : 'done', detail: observation.slice(0, 300) });
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: observation });
      }
    }
    return {
      text: "I've paused after a number of steps to check in. I can keep going from here — choose **Continue** and I'll resume where I left off.",
      platform: lastPlatform,
      model: lastModel,
      workMessages: work(),
      paused: true,
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

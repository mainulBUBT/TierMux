// The Cline-backed engine: the @cline/agents AgentRuntime owns the FULL loop machinery —
// iteration, tool execution, completionPolicy, overflow/compaction recovery (through our
// prepareTurn), mid-run steering, and max-tokens/provider-error recovery — while everything
// the loop talks to stays TierMux: the v3 toolset, the picker (routerModel), the permissions
// policy, the mode system prompts, and the host-owned ChatMessage[] transcript.
import { loadClineRuntime } from './clineRuntime';
import { makePrepareTurn } from './prepareTurn';

import type { AgentMessage, AgentRuntimeEvent, AgentTool, AgentToolContext } from '@cline/shared';
import type { Tool, ToolSet } from 'ai';
import { asSchema } from 'ai';

import type { AgentOpts, AgentResult, ToolEvent } from '../../agent';
import type { ChatMessage, ProposedPlan } from '../../../shared/types';
import { classifyConversation, attachmentKindsFromContent, type TaskKind } from '../../routing';
import { contentToString } from '../../content';
import { buildV3ToolSet, READ_ONLY_TOOLS } from '../tools/v3';
import { getMcpManager } from '../tools/mcp/manager';
import { resolvePolicy, policyFromSettings } from '../../../permissions/policy';
import { composeSystemPrompt } from '../../../context/system';
import { gatherPromptContext } from '../../../context/promptContext';
import { createTierMuxAgentModel, offerForWindow } from './routerModel';
import { findCatalogModel } from '../../../router/picker';
import { diagLog } from '../../../util/diag';

/** maxStepsPerTurn=0 means unlimited in settings; Cline has no unlimited — use a generous cap. */
const UNLIMITED_ITERATIONS = 200;

/** Window assumed before the first onModel report — matches the AUTO_CONDENSE cap in
 *  chatViewProvider. Refined the moment a model actually serves. */
const FALLBACK_CONTEXT_WINDOW = 32_000;

/** Tools Cline may run CONCURRENTLY when the model emits them adjacently — pure reads over
 *  independent inputs. Mutations, shell, the subagent, the plan exit, askUser and every MCP
 *  tool stay sequential; an allowlist means an unknown (MCP) name can never default to
 *  parallel. */
const PARALLEL_SAFE_TOOLS = new Set([
  'readFile', 'listDir', 'glob', 'grep', 'webSearch', 'fetchUrl',
  'outline', 'findSymbol', 'references', 'definition', 'hover', 'getDiagnostics',
]);

/** Files this turn touched, derived from the executed tool calls (same derivation the old
 *  engine used for the "Files changed" recap). */
function changedFilesFrom(messages: ChatMessage[]): Array<{ path: string; status: 'created' | 'modified' | 'deleted' }> {
  const out: Array<{ path: string; status: 'created' | 'modified' | 'deleted' }> = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      let input: { path?: string } = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
      if (!input.path || seen.has(`${tc.function.name}:${input.path}`)) continue;
      seen.add(`${tc.function.name}:${input.path}`);
      if (tc.function.name === 'editFile') out.push({ path: input.path, status: 'modified' });
      if (tc.function.name === 'writeFile') out.push({ path: input.path, status: 'created' });
      if (tc.function.name === 'deleteFile') out.push({ path: input.path, status: 'deleted' });
    }
  }
  return out;
}

function assistantPartText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

/** AgentMessage[] → ChatMessage[] (the host persists the OpenAI-wire shape; this is what the
 *  next turn re-seeds Cline's runtime from, so tool calls and results must round-trip). */
export function agentToChatMessages(messages: readonly AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const parts = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'user') {
      const text = parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
      const calls = parts
        .filter((p): p is Extract<typeof p, { type: 'tool-call' }> => p.type === 'tool-call')
        .map((p) => ({ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } }));
      if (text || calls.length) out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'tool') {
      for (const p of parts) {
        if (p.type !== 'tool-result') continue;
        const value = typeof p.output === 'string' ? p.output
          : p.output === undefined || p.output === null ? ''
          : JSON.stringify(p.output);
        out.push({ role: 'tool', content: value, tool_call_id: p.toolCallId });
      }
    }
  }
  return out;
}

/** ChatMessage[] (host transcript) → AgentMessage[] (runtime seed). System rows are dropped —
 *  the system prompt travels through AgentRuntimeConfig.systemPrompt. */
export function chatToAgentMessages(messages: ChatMessage[], startId: { n: number }): AgentMessage[] {
  const out: AgentMessage[] = [];
  const mk = (role: AgentMessage['role'], content: AgentMessage['content']): AgentMessage => ({
    id: `tmx_${startId.n++}`,
    role,
    content,
    createdAt: Date.now(),
  });
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push(mk('user', [{ type: 'text', text: typeof m.content === 'string' ? m.content : assistantPartText(m.content) }]));
    } else if (m.role === 'assistant') {
      const text = assistantPartText(m.content);
      const parts: AgentMessage['content'] = text ? [{ type: 'text', text }] : [];
      for (const tc of m.tool_calls ?? []) {
        nameById.set(tc.id, tc.function.name);
        let input: unknown;
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
        parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input });
      }
      if (parts.length) out.push(mk('assistant', parts));
    } else if (m.role === 'tool') {
      const name = nameById.get(m.tool_call_id ?? '') ?? 'tool';
      const value = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.push(mk('tool', [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', toolName: name, output: value }]));
    }
  }
  return out;
}

/** AI SDK v3 tool (zod inputSchema, TierMux execute semantics) → Cline AgentTool. Keeps the
 *  whole TierMux toolset — checkpoints, MCP, askUser, exitPlanMode — under Cline's loop. */
function wrapSdkTool(name: string, t: Tool, planMode: boolean): AgentTool | undefined {
  const anyTool = t as { description?: string; inputSchema?: unknown; execute?: (input: unknown, o: unknown) => Promise<unknown> };
  const execute = anyTool.execute;
  if (typeof execute !== 'function') return undefined;
  let inputSchema: Record<string, unknown> = { type: 'object', properties: {} };
  try {
    const json = asSchema(anyTool.inputSchema as never).jsonSchema;
    if (json && typeof json === 'object') inputSchema = json as Record<string, unknown>;
  } catch { /* schemaless tool keeps the empty object schema */ }
  return {
    name,
    description: anyTool.description ?? '',
    inputSchema,
    // Plan mode's terminal tool: a non-error exitPlanMode result IS the completed run
    // (completionPolicy.requireCompletionTool makes it the ONLY way to end the turn).
    ...(planMode && name === 'exitPlanMode' ? { lifecycle: { completesRun: true } } : {}),
    ...(PARALLEL_SAFE_TOOLS.has(name) ? { executionMode: 'parallel' as const } : {}),
    async execute(input: unknown, ctx: AgentToolContext) {
      return execute(input, {
        toolCallId: ctx.toolCallId ?? `${name}_${ctx.iteration}`,
        messages: [],
        abortSignal: ctx.signal,
      });
    },
  };
}

function mapFinishReason(status: string, error?: Error): string {
  if (error) return 'unknown';
  return status === 'failed' ? 'unknown' : 'stop';
}

/** The `reason` half of a denied resolvePolicy verdict — Cline appends it to the tool result
 *  the model reads, so "plan mode is read-only…" reaches the model instead of a bare
 *  "user rejected". */
function denyReason(verdict: unknown): string {
  if (verdict && typeof verdict === 'object' && 'reason' in verdict) {
    const r = (verdict as { reason?: unknown }).reason;
    if (typeof r === 'string' && r) return r;
  }
  return 'blocked by the permission policy';
}

/** Test seam: when set, the engine uses this scripted AgentModel instead of the picker router.
 *  Production never sets it. Mirrors the old engine's __setEngineModelForTests. */
let modelOverride: import('@cline/shared').AgentModel | undefined;
export function __setClineEngineModelForTests(m: import('@cline/shared').AgentModel | undefined): void {
  modelOverride = m;
}

/** The Cline turn. Same contract the AI SDK engine served: opts in, AgentResult out, the host
 *  (chatViewProvider) unchanged apart from losing the ask runner. */
export async function runTurn(_router: unknown, opts: AgentOpts): Promise<AgentResult> {
  const t0 = Date.now();
  const mode = opts.mode;
  diagLog('engine.start', `mode=${mode} msgs=${opts.messages?.length ?? 0} requestId=${opts.requestId ?? '-'}`);

  const userTurns = (opts.messages ?? []).filter((m) => m.role === 'user');
  const userTexts = userTurns.map((m) => contentToString(m.content));
  const latestUserContent = userTurns.at(-1)?.content;
  const latestKinds = latestUserContent !== undefined ? attachmentKindsFromContent(latestUserContent) : [];
  const taskKind: TaskKind = (opts.taskKind as TaskKind | undefined) ?? classifyConversation(
    userTexts,
    {
      mentions: opts.mentionCount,
      auto: !opts.pinnedModel || opts.pinnedModel === 'auto',
      attachmentKinds: latestKinds,
      attachments: latestKinds.length,
    },
  );

  let proposedPlan: ProposedPlan | undefined;
  let served: { platform?: string; model?: string; runtimeName?: string } = {};
  let iteration = 0;
  let lastWindow = FALLBACK_CONTEXT_WINDOW;
  const reasoningParts: string[] = [];

  const tools: ToolSet = buildV3ToolSet(mode, {
    abortSignal: opts.abortSignal,
    sessionId: opts.sessionId,
    requestId: opts.requestId,
    onTodos: (todos) => opts.onTodos(todos),
    onBeforeWrite: opts.onBeforeWrite,
    onAskUser: opts.onAskUser,
    onPlanProposed: (plan) => { proposedPlan = plan; },
  }) as ToolSet;

  const planMode = mode === 'plan';
  const clineTools: AgentTool[] = Object.entries(tools)
    .map(([name, t]) => wrapSdkTool(name, t as Tool, planMode))
    .filter((t): t is AgentTool => !!t);

  // Small-window schema tax. With a PIN the serving head is known up front, so the offer is
  // trimmed here; the unpinned path re-applies the same rule per request inside routerModel,
  // where the rotation actually picks the head.
  let headWindow: number | undefined;
  if (opts.pinnedModel && opts.pinnedModel !== 'auto') {
    const at = opts.pinnedModel.indexOf('::');
    if (at > 0) {
      headWindow = findCatalogModel(opts.pinnedModel.slice(0, at), opts.pinnedModel.slice(at + 2))?.contextWindow ?? undefined;
    }
  }
  const offeredTools = offerForWindow(headWindow, clineTools);

  const toolPolicies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {};
  for (const t of clineTools) {
    toolPolicies[t.name] = { enabled: true, autoApprove: READ_ONLY_TOOLS.has(t.name) };
  }

  const sessionFilesBlock = await opts.sessionFiles?.().catch(() => undefined);
  const system = composeSystemPrompt(mode, await gatherPromptContext(), opts.todos,
    mode === 'agent' ? getMcpManager()?.instructions() : undefined)
    + (sessionFilesBlock ? `\n\n${sessionFilesBlock}` : '');

  const policy = policyFromSettings(opts.autoApprove ?? false, mode, opts.sessionId);
  // Seeding: everything up to (not including) the latest user message goes in as history; the
  // latest user message is the run input. restore() keeps this stateless per turn — the host
  // owns the transcript, exactly like the old engine.
  const seedAll = chatToAgentMessages(opts.messages ?? [], { n: 0 });
  const lastUser = userTexts.at(-1) ?? '';
  let history = seedAll;
  if (history.at(-1)?.role === 'user') history = history.slice(0, -1);

  // Mid-run steering: the host pushes user text while the run is busy; the runtime interrupts
  // only its in-flight MODEL request (running tools finish) and consumePendingUserMessage
  // drains the queue into the transcript at the next iteration boundary.
  const steerQueue: string[] = [];
  let runtimeRef: { notifyPendingUserMessage(): void } | undefined;
  opts.onSteerReady?.({
    push: (text: string) => {
      steerQueue.push(text);
      runtimeRef?.notifyPendingUserMessage();
    },
  });

  const { AgentRuntime } = loadClineRuntime();
  const runtime = new AgentRuntime({
    sessionId: opts.sessionId,
    conversationId: opts.requestId ? `cnv_${opts.requestId}` : undefined,
    systemPrompt: system,
    model: modelOverride ?? createTierMuxAgentModel({
      taskKind,
      effort: opts.effort,
      pinnedModel: opts.pinnedModel,
      excludeModels: opts.excludeModels,
      abortSignal: opts.abortSignal,
      sessionId: opts.sessionId,
      onModel: (platform, model, runtimeName) => {
        served = { platform, model, runtimeName };
        const win = findCatalogModel(platform, model)?.contextWindow;
        if (win) lastWindow = win;
        opts.onModel(platform, model, runtimeName);
      },
      onFailover: (from, reason) => opts.onFailover?.(from, reason),
      onSelectionRationale: opts.onSelectionRationale,
      onKeyRotated: opts.onKeyRotated,
      onUsage: (info) => {
        // usage-updated is deliberately NOT handled: routerModel's per-request report is the
        // source of truth (the runtime's cumulative event would double-add to the host's
        // trackers). contextTokens + contextWindow drive the live context-pressure chip.
        opts.usageSink?.({
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
          contextTokens: info.contextTokens,
          contextWindow: lastWindow,
          model: info.model,
          pass: iteration,
        });
      },
    }),
    tools: offeredTools,
    toolPolicies,
    maxIterations: opts.maxStepsPerTurn === undefined ? 40
      : opts.maxStepsPerTurn < 1 ? UNLIMITED_ITERATIONS
      : opts.maxStepsPerTurn,
    // Plan mode's stop condition, Cline-native: requireCompletionTool + exitPlanMode's
    // lifecycle.completesRun make an ACCEPTED exitPlanMode the only way to complete the run;
    // a prose-only finish gets the runtime's mechanical "[SYSTEM] This run is not complete…"
    // reminder instead of ending the turn (the plan-gap nudge, no narration detector).
    ...(planMode ? { completionPolicy: { requireCompletionTool: true } } : {}),
    // Host-owned request projection: per-step tool-output aging + compaction at 80% of the
    // serving window, and the runtime's ONE overflow recovery (context_window_exceeded →
    // forced shrink → retry) routes through here. Affects the provider request only.
    prepareTurn: makePrepareTurn({
      level: opts.toolCompaction ?? 'light',
      windowOf: () => lastWindow,
      onNotice: (message) => opts.onStep('status', message),
    }),
    consumePendingUserMessage: () => steerQueue.shift(),
    requestToolApproval: async (req) => {
      const verdict = await resolvePolicy({ toolName: req.toolName, input: req.input }, policy, async (r) => {
        if (!opts.onPermissionAsk) return 'deny';
        const input = (r.input ?? {}) as { command?: string; path?: string };
        const v = await opts.onPermissionAsk({
          title: `Allow ${r.tool}?`,
          toolName: r.tool,
          ...(input.command ? { command: input.command } : {}),
          ...(input.path ? { pattern: input.path } : {}),
        });
        return v === 'once' ? 'allow' : v === 'always' ? 'allow-always' : 'deny';
      });
      const approved = verdict === 'approved'
        || (typeof verdict === 'object' && verdict !== null && 'type' in verdict && (verdict as { type?: string }).type === 'approved');
      return approved ? { approved: true } : { approved: false, reason: denyReason(verdict) };
    },
    hooks: {
      // A REJECTED plan must not complete the run: exitPlanMode keeps validation recoverable
      // as a plain { error } OUTPUT object (exitPlanMode.ts), which a completesRun tool would
      // read as success. Marking it isError makes findCompletingToolMessage skip it — the loop
      // continues so the model reads the error and revises. Accepted plans complete natively.
      afterTool: async ({ toolCall, result }) => {
        if (!planMode || toolCall.toolName !== 'exitPlanMode') return undefined;
        const out = result?.output;
        const rejected = typeof out === 'object' && out !== null && 'error' in (out as Record<string, unknown>);
        return rejected ? { result: { ...result, isError: true } } : undefined;
      },
    },
  });
  runtimeRef = runtime;

  const onEvent = (e: AgentRuntimeEvent) => {
    if (e.type === 'assistant-text-delta') {
      opts.onChunk(e.text);
    } else if (e.type === 'assistant-reasoning-delta') {
      reasoningParts.push(e.text);
      opts.onReasoning(e.text);
    } else if (e.type === 'tool-started') {
      const ev: ToolEvent = { toolCallId: e.toolCall.toolCallId, name: e.toolCall.toolName, args: e.toolCall.input, state: 'running' };
      opts.onTool(ev);
    } else if (e.type === 'tool-finished') {
      const resultPart = e.message.content.find((p) => p.type === 'tool-result') as { isError?: boolean; output?: unknown } | undefined;
      const output = resultPart?.output;
      const detail = typeof output === 'string' ? output
        : output === undefined || output === null ? undefined
        : JSON.stringify(output);
      const ev: ToolEvent = {
        toolCallId: e.toolCall.toolCallId,
        name: e.toolCall.toolName,
        args: e.toolCall.input,
        state: resultPart?.isError ? 'error' : 'done',
        ...(detail ? { detail: detail.slice(0, 400) } : {}),
      };
      opts.onTool(ev);
    } else if (e.type === 'turn-started') {
      iteration = e.iteration;
      // No label: the webview's own rolling activity ("Reading …", "Searching …") is more
      // informative than a step counter, and an explicit label would override it.
      opts.onStep('thinking');
    } else if (e.type === 'status-notice') {
      opts.onStep('status', e.message);
    } else if (e.type === 'run-failed') {
      opts.onError(e.error?.message || 'The Cline turn failed.');
    }
  };
  const unsubscribe = runtime.subscribe(onEvent);

  const onAbort = () => runtime.abort('user stop');
  opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (history.length) runtime.restore(history);
    const result = await runtime.run(lastUser);
    const workMessages = agentToChatMessages(result.messages);
    if (opts.abortSignal?.aborted) {
      // runtime.abort() can settle the run as a normal result — still a resumable pause.
      return { text: result.outputText, finishReason: 'unknown', platform: served.platform, model: served.model, runtimeName: 'cline', taskKind, workMessages, paused: true };
    }
    diagLog('engine.done', `status=${result.status} iters=${result.iterations} ms=${Date.now() - t0}`);
    if (result.status === 'failed') {
      const message = result.error?.message || 'The Cline turn failed.';
      opts.onError(message);
      return {
        text: '',
        finishReason: 'unknown',
        platform: served.platform,
        model: served.model,
        runtimeName: served.runtimeName ?? 'cline',
        taskKind,
        workMessages,
        failed: true,
        errorMessage: message,
      };
    }
    return {
      // With completesRun, the runtime's outputText is the COMPLETING TOOL's return value —
      // exitPlanMode's meta-string ("Finding reported to the user. Stop here…"), which shipped
      // as the assistant's answer (live repro: "hika" run, Opencode/big-pickle, 2026-09-23).
      // The card is the UI for a declared plan/finding; never surface the tool's echo.
      text: proposedPlan ? '' : result.outputText,
      ...(reasoningParts.length ? { reasoning: reasoningParts.join('') } : {}),
      finishReason: mapFinishReason(result.status),
      platform: served.platform,
      model: served.model,
      runtimeName: served.runtimeName ?? 'cline',
      taskKind,
      workMessages,
      changedFiles: changedFilesFrom(workMessages),
      plan: proposedPlan,
    };
  } catch (e) {
    if (opts.abortSignal?.aborted) {
      // Abort keeps the host's Continue flow alive: the transcript persisted so far is a valid
      // resumable pause, not a failed turn.
      return { text: '', finishReason: 'unknown', platform: served.platform, model: served.model, runtimeName: 'cline', taskKind, paused: true };
    }
    const message = e instanceof Error ? e.message : String(e);
    opts.onError(message);
    return {
      text: '',
      finishReason: 'unknown',
      platform: served.platform,
      model: served.model,
      runtimeName: 'cline',
      taskKind,
      failed: true,
      errorMessage: message,
    };
  } finally {
    opts.abortSignal?.removeEventListener('abort', onAbort);
    unsubscribe();
    opts.onSteerReady?.(undefined);
  }
}

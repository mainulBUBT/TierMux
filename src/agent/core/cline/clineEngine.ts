// The Cline-backed engine: replaces the AI SDK streamText loop with @cline/agents'
// AgentRuntime while keeping EVERYTHING else TierMux — the v3 toolset, the picker, the
// permissions policy, the mode system prompts, the transcript wire shape. Cline owns only
// the loop (iteration, tool execution, overflow/compaction recovery); TierMux owns what the
// loop talks to. Ask mode is gone on this branch: it maps to plan (read-only) defensively
// for old persisted sessions.
import { loadClineRuntime } from './clineRuntime';

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
function wrapSdkTool(name: string, t: Tool): AgentTool | undefined {
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
  // Ask mode is dropped on this branch; a stale persisted session still lands somewhere sane.
  const mode = opts.mode === 'ask' ? 'plan' : opts.mode;
  diagLog('engine.start', `mode=${opts.mode}→${mode} msgs=${opts.messages?.length ?? 0} requestId=${opts.requestId ?? '-'}`);

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

  const clineTools: AgentTool[] = Object.entries(tools)
    .map(([name, t]) => wrapSdkTool(name, t as Tool))
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
      onModel: (platform, model, runtimeName) => {
        served = { platform, model, runtimeName };
        opts.onModel(platform, model, runtimeName);
      },
      onFailover: (from, reason) => opts.onFailover?.(from, reason),
      onUsage: (info) => {
        opts.usageSink?.({
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
          contextTokens: info.contextTokens,
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
      return { approved };
    },
    hooks: {
      // Plan mode's stop condition: an ACCEPTED exitPlanMode result ends the run; a rejected
      // one (error output) keeps the loop alive so the model can revise — same semantics the
      // old engine's planAccepted StopCondition enforced.
      afterTool: async ({ toolCall, result }) => {
        if (mode !== 'plan' || toolCall.toolName !== 'exitPlanMode') return undefined;
        const out = result?.output;
        const rejected = typeof out === 'object' && out !== null && 'error' in (out as Record<string, unknown>);
        return rejected ? undefined : { stop: true, reason: 'plan accepted' };
      },
    },
  });

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
      opts.onStep('thinking', iteration > 1 ? `Continuing (step ${iteration})…` : 'Thinking…');
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
      text: result.outputText,
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
  }
}

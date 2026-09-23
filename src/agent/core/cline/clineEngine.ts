// The agent is Cline. @cline/agents runs the loop; @cline/core supplies the harness — the
// builtin tools and their executors, the system prompt, rules and skills, MCP tools and request
// compaction. TierMux supplies only what a host must: the model (the router, routerModel.ts),
// the approval decision, the ask-question card, the checkpoint baseline, and the UI events.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadClineCore, loadClineRuntime, type ClineCoreModule } from './clineRuntime';
import { makePrepareTurn } from './prepareTurn';

import type { AgentMessage, AgentRuntimeEvent, AgentTool } from '@cline/shared';

import type { AgentOpts, AgentResult, ToolEvent } from '../../agent';
import type { ChatMessage } from '../../../shared/types';
import { classifyConversation, attachmentKindsFromContent, type TaskKind } from '../../routing';
import { contentToString } from '../../content';
import { getMcpManager } from '../../../mcp/mcpManager';
import { resolvePolicy, policyFromSettings, READ_ONLY_TOOLS } from '../../../permissions/policy';
import { commandFromInput } from '../../../edits/commandClassify';
import { createTierMuxAgentModel } from './routerModel';
import { findCatalogModel } from '../../../router/picker';
import { peekWorkspaceRoot } from '../../../util/workspaceRoot';
import { diagLog } from '../../../util/diag';

/** maxStepsPerTurn=0 means unlimited in settings; Cline has no unlimited — use a generous cap. */
const UNLIMITED_ITERATIONS = 200;

/** Window assumed before the first onModel report — matches the AUTO_CONDENSE cap in
 *  chatViewProvider. Refined the moment a model actually serves. */
const FALLBACK_CONTEXT_WINDOW = 32_000;

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

function workspaceCwd(): string {
  return peekWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

/** Rules and skills load through Cline's instruction service (.clinerules, AGENTS.md,
 *  .cline/skills, .agents/skills …). One watched service per workspace root. */
const instructionServices = new Map<string, Promise<ReturnType<ClineCoreModule['createUserInstructionConfigService']>>>();
function instructionsFor(core: ClineCoreModule, cwd: string) {
  let svc = instructionServices.get(cwd);
  if (!svc) {
    svc = (async () => {
      const s = core.createUserInstructionConfigService({
        skills: { workspacePath: cwd },
        rules: { workspacePath: cwd },
        workflows: { workspacePath: cwd },
      });
      await s.start();
      return s;
    })();
    instructionServices.set(cwd, svc);
  }
  return svc;
}

/** Test seam: when set, the engine uses this scripted AgentModel instead of the picker router. */
let modelOverride: import('@cline/shared').AgentModel | undefined;
export function __setClineEngineModelForTests(m: import('@cline/shared').AgentModel | undefined): void {
  modelOverride = m;
}

export async function runTurn(_router: unknown, opts: AgentOpts): Promise<AgentResult> {
  const t0 = Date.now();
  // Anything but 'agent' is read-only — a session persisted in the retired 'ask' mode included.
  const mode = opts.mode === 'agent' ? 'agent' : 'plan';
  const clineMode = mode === 'agent' ? 'act' : 'plan';
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

  let served: { platform?: string; model?: string; runtimeName?: string } = {};
  let iteration = 0;
  let lastWindow = FALLBACK_CONTEXT_WINDOW;
  const reasoningParts: string[] = [];
  const changed = new Map<string, 'created' | 'modified'>();

  const core = loadClineCore();
  const cwd = workspaceCwd();
  const instructions = await instructionsFor(core, cwd).catch(() => undefined);
  const skills = instructions?.hasConfiguredSkills() ? instructions.createSkillsExecutor?.() : undefined;
  type Rule = Parameters<ClineCoreModule['formatRulesForSystemPrompt']>[0][number];
  const rules = instructions?.listRecords<Rule>('rule').map((r) => r.item).filter((r) => !r.disabled) ?? [];

  const editor = core.createEditorExecutor();
  const tools: AgentTool[] = core.createBuiltinTools({
    ...core.ToolPresets[clineMode],
    cwd,
    bashTimeoutMs: vscode.workspace.getConfiguration('tiermux.agent').get<number>('commandTimeoutMs', 120_000),
    executors: {
      ...(skills ? { skills } : {}),
      askQuestion: async (question, options) => {
        const r = await opts.onAskUser([{ question, options }]);
        if (r.status === 'answered') return r.answers.join(', ');
        return r.status === 'dismissed' ? 'The user skipped the question.' : 'The question was cancelled.';
      },
      editor: async (input, dir, ctx) => {
        const abs = path.isAbsolute(input.path) ? input.path : path.join(dir, input.path);
        let before: string | null = null;
        try { before = await fs.promises.readFile(abs, 'utf8'); } catch { before = null; }
        opts.onBeforeWrite?.(vscode.Uri.file(abs), before);
        const out = await editor(input, dir, ctx);
        if (!changed.has(abs)) changed.set(abs, before === null ? 'created' : 'modified');
        return out;
      },
    },
  });
  if (mode === 'agent') tools.push(...await getMcpManager()?.agentTools() ?? []);

  const toolPolicies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {};
  for (const t of tools) toolPolicies[t.name] = { enabled: true, autoApprove: READ_ONLY_TOOLS.has(t.name) };

  const system = core.getClineDefaultSystemPrompt({
    rootPath: cwd,
    mode: clineMode,
    // TierMux is a VS Code host: the user flips Plan/Agent, the model cannot.
    planModeSwitchTool: false,
  }) + core.formatRulesForSystemPrompt(rules);

  const policy = policyFromSettings(opts.autoApprove ?? false, mode, opts.sessionId);
  // Seeding: everything up to (not including) the latest user message goes in as history; the
  // latest user message is the run input. The host owns the transcript.
  const seedAll = chatToAgentMessages(opts.messages ?? [], { n: 0 });
  const lastUser = userTexts.at(-1) ?? '';
  let history = seedAll;
  if (history.at(-1)?.role === 'user') history = history.slice(0, -1);

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
    tools,
    toolPolicies,
    maxIterations: opts.maxStepsPerTurn === undefined ? 40
      : opts.maxStepsPerTurn < 1 ? UNLIMITED_ITERATIONS
      : opts.maxStepsPerTurn,
    prepareTurn: makePrepareTurn(core, {
      level: opts.toolCompaction ?? 'auto',
      sessionId: opts.sessionId,
      windowOf: () => lastWindow,
    }),
    consumePendingUserMessage: () => steerQueue.shift(),
    requestToolApproval: async (req) => {
      const verdict = await resolvePolicy({ toolName: req.toolName, input: req.input }, policy, async (r) => {
        if (!opts.onPermissionAsk) return 'deny';
        const input = (r.input ?? {}) as { path?: string };
        const command = commandFromInput(r.input);
        const v = await opts.onPermissionAsk({
          title: `Allow ${r.tool}?`,
          toolName: r.tool,
          ...(command ? { command } : {}),
          ...(input.path ? { pattern: input.path } : {}),
        });
        return v === 'once' ? 'allow' : v === 'always' ? 'allow-always' : 'deny';
      });
      return verdict.type === 'approved' ? { approved: true } : { approved: false, reason: verdict.reason };
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
      opts.onStep('thinking');
    } else if (e.type === 'status-notice') {
      opts.onStep('status', e.message);
    } else if (e.type === 'run-failed') {
      const message = e.error?.message || 'The Cline turn failed.';
      if (!/exceeded maxIterations/.test(message) && !opts.abortSignal?.aborted) opts.onError(message);
    }
  };
  const unsubscribe = runtime.subscribe(onEvent);

  const onAbort = () => runtime.abort('user stop');
  opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

  const changedFiles = () => [...changed].map(([p, status]) => ({ path: vscode.workspace.asRelativePath(p), status }));

  try {
    if (history.length) runtime.restore(history);
    const result = await runtime.run(lastUser);
    const workMessages = agentToChatMessages(result.messages);
    // Stop, and Cline's step cap ("exceeded maxIterations"), are resumable pauses: the UI's
    // Continue picks the run up from the persisted transcript.
    const stepCapped = result.status === 'failed' && /exceeded maxIterations/.test(result.error?.message ?? '');
    if (opts.abortSignal?.aborted || result.status === 'aborted' || stepCapped) {
      return { text: result.outputText, finishReason: 'unknown', platform: served.platform, model: served.model, runtimeName: 'cline', taskKind, workMessages, paused: true, changedFiles: changedFiles() };
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
        changedFiles: changedFiles(),
      };
    }
    return {
      text: result.outputText,
      ...(reasoningParts.length ? { reasoning: reasoningParts.join('') } : {}),
      finishReason: 'stop',
      platform: served.platform,
      model: served.model,
      runtimeName: served.runtimeName ?? 'cline',
      taskKind,
      workMessages,
      changedFiles: changedFiles(),
    };
  } catch (e) {
    if (opts.abortSignal?.aborted) {
      return { text: '', finishReason: 'unknown', platform: served.platform, model: served.model, runtimeName: 'cline', taskKind, paused: true, changedFiles: changedFiles() };
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

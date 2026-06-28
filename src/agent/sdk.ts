// SDK isolation boundary — only this file imports from 'ai'.
// If Vercel AI SDK changes streamText/generateText APIs, fix here only.
import { streamText, generateText, isStepCount } from 'ai';
import { tool } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { createTiermuxProvider } from './tiermuxProvider';
import type { Router } from '../router/router';
import type { ChatMessage, TodoItem, ReasoningEffort } from '../shared/types';
import { AGENT_SYSTEM, AGENT_SYSTEM_LITE, CHAT_SYSTEM, PLAN_SYSTEM, RESPONSIBILITY_RULES } from './prompts';
import { buildAmbientContext } from '../context/ambient';
import { loadProjectRules } from '../context/projectRules';
import { loadUserMemory } from '../context/userMemory';

// ---- Public types ----

export interface ToolEvent {
  toolCallId: string;
  name: string;
  args?: unknown;
  state: 'queued' | 'running' | 'done' | 'error';
  detail?: string;
}

/** Mirrors agent.ts AgentResult so chatViewProvider needs no changes. */
export interface AgentResult {
  text: string;
  reasoning?: string;
  platform?: string;
  model?: string;
  runtimeName?: string;
  taskKind?: string;
  workMessages?: ChatMessage[];
  paused?: boolean;
}

/** Stable options contract — never tied to a specific SDK version. */
export interface AgentOpts {
  messages: ChatMessage[];
  mode: 'chat' | 'agent' | 'plan';
  effort: ReasoningEffort;
  abortSignal?: AbortSignal;
  pinnedModel?: string;
  taskKind?: string;
  // Streaming callbacks → webview postMessage
  onChunk: (text: string) => void;
  onTool: (e: ToolEvent) => void;
  onReasoning: (text: string) => void;
  onModel: (platform: string, model: string, runtimeName?: string) => void;
  onFailover: (from: string, reason: string) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onStep: (phase: string, label: string) => void;
  onTodos: (todos: TodoItem[]) => void;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  onError: (message: string) => void;
}

export type ToolSet = Record<string, any>;

// ---- Convert Tiermux ChatMessage[] → AI SDK CoreMessage[] ----

function toCoreMessages(msgs: ChatMessage[]) {
  return msgs.map((m): any => {
    if (m.role === 'system') return { role: 'system', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    if (m.role === 'user') return { role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) parts.push({ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let args: unknown = {};
          try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { args = {}; }
          parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, args });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', output: m.content ?? '' }],
      };
    }
    return { role: 'user', content: String(m.content ?? '') };
  });
}

// ---- System prompt selector ----

function systemPrompt(mode: 'chat' | 'agent' | 'plan', effort: ReasoningEffort): string {
  if (mode === 'chat') return CHAT_SYSTEM;
  if (mode === 'plan') return PLAN_SYSTEM;
  return effort === 'low' ? AGENT_SYSTEM_LITE : AGENT_SYSTEM + '\n\n' + RESPONSIBILITY_RULES;
}

// ---- askUser tool factory ----

function makeAskUserTool(opts: AgentOpts) {
  return tool({
    description: 'Ask the user a clarifying question and wait for their reply. Use when you genuinely cannot proceed without user input. Provide optional multiple-choice options when the answer space is constrained.',
    inputSchema: z.object({
      question: z.string().describe('The question to ask the user.'),
      options: z.array(z.string()).optional().describe('Optional multiple-choice answers the user can pick from.'),
    }),
    execute: async ({ question, options }: { question: string; options?: string[] }) => {
      const answer = await opts.onAskUser(question, options);
      return JSON.stringify({ answer: answer?.trim() || '(user skipped this question)' });
    },
  });
}

// ---- Context augmentation (mirrors agent.ts augment() + prepareContext()) ----

async function buildAugmentedSystem(base: string, wantsCode: boolean): Promise<string> {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const [rules, memory] = await Promise.all([
    wantsCode ? loadProjectRules().catch(() => '') : Promise.resolve(''),
    loadUserMemory().catch(() => ''),
  ]);
  let s = `${base}\n\n${RESPONSIBILITY_RULES}\n\n# Current date\nToday is ${today}.`;
  if (memory) s += `\n\n# User style, tone & standing instructions (follow exactly)\n${memory}`;
  if (wantsCode && rules) s += `\n\n# Project rules (follow these)\n${rules}`;
  return s;
}

/** Prepend ambient editor context as a user turn just before the last user message. */
function injectAmbient(messages: ChatMessage[]): ChatMessage[] {
  const ambient = buildAmbientContext();
  if (!ambient) return messages;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return messages;
  const ctx: ChatMessage = { role: 'user', content: `Editor context:\n${ambient}` };
  return [...messages.slice(0, lastUserIdx), ctx, ...messages.slice(lastUserIdx)];
}

// ---- Core runner ----

async function runStream(router: Router, opts: AgentOpts, tools: ToolSet): Promise<AgentResult> {
  let platform = '';
  let model = '';
  let text = '';
  let reasoning = '';

  const modelProvider = createTiermuxProvider(router, {
    effort: opts.effort,
    pinnedModel: opts.pinnedModel,
    onFailover: (info) => opts.onFailover(info.from, info.reason),
    onKeyRotated: opts.onKeyRotated
      ? (info) => opts.onKeyRotated!({ platform: info.platform, keyIndex: info.keyIndex, keyTotal: info.keyTotal })
      : undefined,
    onModelSelected: (p, m) => { platform = p; model = m; opts.onModel(p, m); },
  });

  const isChat = opts.mode === 'chat';
  const wantsCode = !isChat || true; // always inject project rules + memory

  // Build augmented system prompt (rules, memory, date) and inject ambient editor context
  const [augmentedSystem, augmentedMessages] = await Promise.all([
    buildAugmentedSystem(systemPrompt(opts.mode, opts.effort), wantsCode),
    Promise.resolve(injectAmbient(opts.messages)),
  ]);

  // Inject askUser tool (all modes — chat may need clarification too)
  const activeTools = isChat ? undefined : { ...tools, askUser: makeAskUserTool(opts) };

  // Fire "Working…" immediately so the UI never looks frozen during TTFT latency.
  opts.onStep('thinking', 'Working…');

  let stepNumber = 0;
  let finishReason = 'stop';

  try {
    const streamResult = streamText({
      model: modelProvider,
      system: augmentedSystem,
      messages: toCoreMessages(augmentedMessages),
      tools: activeTools,
      stopWhen: isStepCount(isChat ? 1 : 50),
      abortSignal: opts.abortSignal,
      onStepFinish: ({ finishReason: fr }: any) => {
        stepNumber++;
        opts.onStep('working', `Step ${stepNumber}`);
        finishReason = fr ?? finishReason;
      },
    });

    // Consume the full event stream directly — each TextStreamPart handled inline.
    // This is the most reliable driver: no callback timing, no textStream filtering.
    for await (const part of streamResult.stream) {
      if (part.type === 'text-delta') { text += part.text; opts.onChunk(part.text); }
      else if (part.type === 'reasoning-delta') { reasoning += (part as any).delta ?? (part as any).text ?? ''; opts.onReasoning(reasoning); }
      else if (part.type === 'tool-call') opts.onTool({ toolCallId: (part as any).toolCallId, name: (part as any).toolName, args: (part as any).input, state: 'running' });
      else if (part.type === 'tool-result') {
        const tp = part as any;
        const detail = typeof tp.output === 'string' ? tp.output : JSON.stringify(tp.output ?? '');
        opts.onTool({ toolCallId: tp.toolCallId, name: tp.toolName, args: tp.input, state: 'done', detail });
        if (tp.toolName === 'updateTodos') {
          try {
            const raw = typeof tp.output === 'string' ? JSON.parse(tp.output) : tp.output;
            const list = Array.isArray(raw) ? raw : Array.isArray(raw?.todos) ? raw.todos : null;
            if (list) opts.onTodos(list);
          } catch { /* ignore malformed output */ }
        }
      }
      else if (part.type === 'tool-error') opts.onTool({ toolCallId: (part as any).toolCallId, name: (part as any).toolName, args: (part as any).input, state: 'error', detail: String((part as any).error ?? 'tool error') });
    }

    const usage = await streamResult.usage;
    const steps: any[] = await streamResult.steps ?? [];

    // Build workMessages: tool-call steps only (not the final text step).
    // persistAgentTurn uses workMessages OR result.text — having tool steps in workMessages
    // keeps the tool-call transcript in history for auto-continue; final text goes via result.text.
    const workMessages: ChatMessage[] = [];
    for (const step of steps) {
      const calls: any[] = step.toolCalls ?? [];
      if (calls.length > 0) {
        workMessages.push({
          role: 'assistant',
          content: step.text || null,
          tool_calls: calls.map((tc: any) => ({
            id: tc.toolCallId,
            type: 'function' as const,
            function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
          })),
        });
        for (const tr of step.toolResults ?? []) {
          workMessages.push({
            role: 'tool',
            content: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? ''),
            tool_call_id: tr.toolCallId,
          });
        }
      }
    }

    // Usage reporting: chatViewProvider tracks usage via usage.get() diff.
    // We also forward it to onError if needed (no-op here — usage is passive).
    void usage; // suppress unused warning; chatViewProvider uses before/after diff

    return {
      text,
      reasoning: reasoning.trim() || undefined,
      platform: platform || undefined,
      model: model || undefined,
      taskKind: opts.taskKind,
      workMessages: workMessages.length > 0 ? workMessages : undefined,
      paused: finishReason === 'length',
    };
  } catch (err: unknown) {
    if ((err as any)?.name === 'AbortError') {
      return { text, reasoning: reasoning.trim() || undefined, platform: platform || undefined, model: model || undefined };
    }
    opts.onError(err instanceof Error ? err.message : String(err));
    return { text, reasoning: reasoning.trim() || undefined, platform: platform || undefined, model: model || undefined };
  }
}

// ---- Public API — what chatViewProvider calls ----

/** Chat mode: single turn, no tools, fastest path. */
export async function runChatStream(router: Router, opts: AgentOpts): Promise<AgentResult> {
  return runStream(router, { ...opts, mode: 'chat' }, {});
}

/** Agent mode: multi-step tool loop, up to 50 steps. */
export async function runAgentStream(router: Router, opts: AgentOpts, tools: ToolSet): Promise<AgentResult> {
  return runStream(router, { ...opts, mode: 'agent' }, tools);
}

/** Plan mode: read-only tool loop (no write/edit/delete/runCommand). */
export async function runPlanStream(router: Router, opts: AgentOpts, tools: ToolSet): Promise<AgentResult> {
  const readOnlyTools = Object.fromEntries(
    Object.entries(tools).filter(([name]) =>
      !['writeFile', 'createFile', 'editFile', 'deleteFile', 'runCommand'].includes(name)
    )
  );
  return runStream(router, { ...opts, mode: 'plan' }, readOnlyTools);
}

/** Session title: single generateText call, low effort, no tools. */
export async function generateSessionTitle(router: Router, firstMessage: string): Promise<string> {
  try {
    const model = createTiermuxProvider(router, { effort: 'low' });
    const { text } = await generateText({
      model,
      maxOutputTokens: 16,
      prompt: `Generate a 2-5 word title for a chat that starts with: "${firstMessage.slice(0, 200)}"\nReply with ONLY the title, no punctuation, no quotes.`,
    });
    return text.trim().slice(0, 60) || '';
  } catch {
    return '';
  }
}

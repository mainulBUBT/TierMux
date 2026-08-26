// POC ONLY — v3 thin agent wrapper (plan §1). This is the shape src/agent/agent.ts takes in
// step 4: TierMux as policy/orchestration, AI SDK as execution engine.
//
//   streamText owns: parsing/validation, tool execution, the multi-step loop, abort,
//                    execute-error wrapping (Path B), streaming.
//   This wrapper owns: which model, which tools, permission policy (toolApproval),
//                      malformed-call self-correction (repairToolCall), compaction
//                      (prepareStep), the 50-step cap (stopWhen), event forwarding.

import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { makeRepairViaModelSelfCorrection } from './repair';
import { resolvePolicy, defaultPolicy, type PolicyConfig, type ApprovalDecision } from './policy';
import { compactIfNeeded } from './compact';

export interface AgentStreamOpts {
  prompt: string;
  /** Prior turns as ModelMessage[] (history + this prompt are the turn's input). */
  history?: ModelMessage[];
  model: LanguageModel;
  tools: ToolSet;
  system?: string;
  policy?: PolicyConfig;
  /** Context-window budget for compaction; 0 disables. */
  contextWindowTokens?: number;
  signal?: AbortSignal;
  requestApproval?: (req: { tool: string; input?: unknown }) => Promise<ApprovalDecision | undefined>;

  onChunk?: (text: string) => void;
  onTool?: (event: { toolName: string; status: 'started' | 'succeeded' | 'failed'; input?: unknown }) => void;
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void;
  onError?: (err: unknown) => void;
  onDone?: (result: { finishReason: string; text: string; steps: number }) => void;
}

export interface AgentStreamResult {
  finishReason: string;
  text: string;
  repairs: number;
  steps: number;
}

export async function runAgentStream(opts: AgentStreamOpts): Promise<AgentStreamResult> {
  const messages: ModelMessage[] = [
    ...(opts.history ?? []),
    { role: 'user', content: opts.prompt },
  ];

  const policy = opts.policy ?? defaultPolicy;
  const { repair, count } = makeRepairViaModelSelfCorrection({ model: opts.model, signal: opts.signal });

  // Capture the outcome from onEnd — the PromiseLike accessors (text/steps) can't be read
  // after consumeStream() has already driven the stream.
  let outcome: { finishReason: string; text: string; steps: number } = { finishReason: 'unknown', text: '', steps: 0 };

  const result = streamText({
    model: opts.model,
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    messages,
    tools: opts.tools,

    // TierMux policy: permission priority chain (plan §3).
    toolApproval: ({ toolCall }) =>
      resolvePolicy({ toolName: toolCall.toolName, input: toolCall.input }, policy, opts.requestApproval),

    // TierMux policy: malformed-call self-correction with a per-turn budget (plan §2).
    repairToolCall: repair,

    // TierMux policy: minimal token-budget compaction (plan §5).
    prepareStep: ({ messages: msgs }) => compactIfNeeded(msgs, opts.contextWindowTokens ?? 0),

    // v3.0 stop conditions: the step cap only — natural model termination ends the turn.
    stopWhen: [stepCountIs(50)],

    abortSignal: opts.signal,
    maxRetries: 1,

    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta') opts.onChunk?.(chunk.text);
    },

    onStepEnd: (step) => {
      for (const tc of step.toolCalls ?? []) {
        opts.onTool?.({ toolName: tc.toolName, status: 'started', input: tc.input });
      }
      // Verified (dbgScenario5): a thrown execute lands in step.content as a
      // { type: 'tool-error', error } part — step.toolResults stays empty. A denied or
      // error-shaped output instead carries output.type 'error-text'|'error-json'|
      // 'execution-denied' in toolResults.
      const failedTools = new Set<string>();
      for (const part of (step.content as Array<{ type?: string; toolName?: string }>)) {
        if (part.type === 'tool-error' && part.toolName) failedTools.add(part.toolName);
      }
      for (const tr of step.toolResults ?? []) {
        const part = tr as { output?: { type?: string } };
        if (part.output?.type === 'error-text' || part.output?.type === 'error-json' || part.output?.type === 'execution-denied') {
          failedTools.add(tr.toolName);
        }
      }
      for (const tr of step.toolResults ?? []) {
        opts.onTool?.({
          toolName: tr.toolName,
          status: failedTools.has(tr.toolName) ? 'failed' : 'succeeded',
          input: tr.input,
        });
      }
      for (const name of failedTools) {
        if (!opts.onTool) break;
        // tool-error parts have no toolResults entry — emit the failure directly.
        const call = (step.toolCalls ?? []).find((tc) => tc.toolName === name);
        opts.onTool({ toolName: name, status: 'failed', input: call?.input });
      }
    },

    onError: ({ error }) => opts.onError?.(error),

    onEnd: ({ steps, totalUsage, finishReason }) => {
      outcome = {
        finishReason: String(finishReason),
        text: steps.at(-1)?.text ?? '',
        steps: steps.length,
      };
      opts.onUsage?.({
        inputTokens: (totalUsage as { inputTokens?: { total?: number } })?.inputTokens?.total,
        outputTokens: (totalUsage as { outputTokens?: { total?: number } })?.outputTokens?.total,
      });
      opts.onDone?.(outcome);
    },
  });

  await result.consumeStream();

  return { ...outcome, repairs: count() };
}

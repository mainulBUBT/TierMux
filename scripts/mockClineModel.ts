// Scripted Cline AgentModel for the cline-agent branch's e2e suites. Plays the SAME script
// shape as mockModel.ts (MockResponse: text / toolCalls / error / hang) but emits Cline
// AgentModelEvents, so engine scenarios port with their step lists intact. Differences from
// the AI SDK mock are the loop's: there is no finish 'length' ladder here — Cline's runtime
// owns output-limit recovery — and `hang` resolves on the abort signal.

import type { AgentModel, AgentModelEvent, AgentModelRequest } from '@cline/shared';

/** One scripted model response. Same shape as mockModel's MockResponse. */
export interface MockResponse {
  text?: string;
  reasoning?: string;
  reasoningDeltas?: string[];
  toolCalls?: Array<{ toolCallId?: string; toolName: string; input: unknown }>;
  error?: Error;
  hang?: boolean;
  /** Accepted for script compatibility; the Cline runtime owns length recovery, so this is
   *  treated as 'stop' at the model boundary. */
  finish?: 'stop' | 'length';
  /** Chain-exhausted finish event: routes the runtime's recovery policy (retry / overflow
   *  recovery / terminal) — emitted instead of any content. */
  finishError?: { error: string; errorClass?: 'auth' | 'context_window_exceeded'; errorRetryable?: boolean };
  /** Provider-measured usage emitted with this step's finish event (exercises the usage sink). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Holds the request open (like `hang`) but resolves the moment `release()` is called —
   *  steering (notifyPendingUserMessage) interrupts only the in-flight model request, so the
   *  test releases it instead of aborting the whole run. */
  hangUntilSteer?: boolean;
}

export interface ScriptedClineModel extends AgentModel {
  /** Every call's full request (for assertions about what the model SAW). */
  calls: AgentModelRequest[];
  name: string;
  /** Unblocks a pending hangUntilSteer request. */
  release(): void;
}

export function createMockModel(script: MockResponse[], name = 'mock-cline'): ScriptedClineModel {
  let release: (() => void) | undefined;
  const model: ScriptedClineModel = {
    name,
    calls: [],
    release() {
      release?.();
    },
    stream(request: AgentModelRequest) {
      model.calls.push(request);
      const step = script[Math.min(model.calls.length - 1, script.length - 1)] ?? {};
      return (async function* (): AsyncGenerator<AgentModelEvent> {
        if (step.error) throw step.error;
        if (step.reasoning) yield { type: 'reasoning-delta', text: step.reasoning };
        if (step.reasoningDeltas?.length) {
          for (const t of step.reasoningDeltas) yield { type: 'reasoning-delta', text: t };
        }
        if (step.hang || step.hangUntilSteer) {
          yield { type: 'text-delta', text: step.text ?? '' };
          // Emulate a stalled provider: settle when the runtime's signal aborts (the runtime
          // threads its abort signal through the model request). hangUntilSteer additionally
          // settles when the test calls model.release() — the same way a steering interrupt
          // (notifyPendingUserMessage) aborts only the in-flight model request.
          await new Promise<void>((resolve) => {
            if (step.hangUntilSteer) release = resolve;
            if (request.signal?.aborted) resolve();
            else request.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('This operation was aborted');
        }
        if (step.text) yield { type: 'text-delta', text: step.text };
        if (step.toolCalls?.length) {
          for (const tc of step.toolCalls) {
            yield {
              type: 'tool-call-delta',
              toolCallId: tc.toolCallId ?? `call_${model.calls.length}_${tc.toolName}`,
              toolName: tc.toolName,
              input: tc.input,
            };
          }
          if (step.usage) yield { type: 'usage', usage: { inputTokens: step.usage.inputTokens, outputTokens: step.usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } };
          yield { type: 'finish', reason: 'tool-calls' };
          return;
        }
        if (step.finishError) {
          yield { type: 'finish', reason: 'error', error: step.finishError.error, ...(step.finishError.errorClass !== undefined ? { errorClass: step.finishError.errorClass } : {}), ...(step.finishError.errorRetryable !== undefined ? { errorRetryable: step.finishError.errorRetryable } : {}) };
          return;
        }
        if (step.usage) yield { type: 'usage', usage: { inputTokens: step.usage.inputTokens, outputTokens: step.usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  return model;
}

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
}

export interface ScriptedClineModel extends AgentModel {
  /** Every call's full request (for assertions about what the model SAW). */
  calls: AgentModelRequest[];
  name: string;
}

export function createMockModel(script: MockResponse[], name = 'mock-cline'): ScriptedClineModel {
  const model: ScriptedClineModel = {
    name,
    calls: [],
    stream(request: AgentModelRequest) {
      model.calls.push(request);
      const step = script[Math.min(model.calls.length - 1, script.length - 1)] ?? {};
      return (async function* (): AsyncGenerator<AgentModelEvent> {
        if (step.error) throw step.error;
        if (step.reasoning) yield { type: 'reasoning-delta', text: step.reasoning };
        if (step.reasoningDeltas?.length) {
          for (const t of step.reasoningDeltas) yield { type: 'reasoning-delta', text: t };
        }
        if (step.hang) {
          yield { type: 'text-delta', text: step.text ?? '' };
          // Emulate a stalled provider: settle when the runtime's signal aborts (the runtime
          // threads its abort signal through the model request).
          await new Promise<void>((resolve) => {
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
          yield { type: 'finish', reason: 'tool-calls' };
          return;
        }
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  return model;
}

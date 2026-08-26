// POC ONLY — scripted LanguageModelV4 for the v3 foundation scenarios (step 1 of the plan).
// This file is deleted with the rest of src/agent/poc/ once the real agent.ts lands (step 4).
//
// The script is a FIFO queue: every doStream/doGenerate call pops the next response.
// A response can be plain text (final answer), native tool calls (args as an object —
// serialized to the raw JSON string the SDK's parseToolCall expects), or a raw/malformed
// input string to exercise the InvalidToolInputError path, or an unknown tool name to
// exercise NoSuchToolError. `hang` emulates a stalled provider so abort can be tested.

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';

/** One scripted model response. Exactly one shape applies. */
export interface MockResponse {
  /** Final-answer prose (finish_reason "stop"). */
  text?: string;
  /** Reasoning emitted BEFORE any text/tool calls (reasoning-start/delta/end parts). */
  reasoning?: string;
  /** Native tool calls. `input` is an object (serialized) or a raw string passed through
   *  verbatim — a deliberately malformed string exercises the repair path. */
  toolCalls?: Array<{ toolCallId?: string; toolName: string; input: unknown }>;
  /** Fail the call outright (provider error). */
  error?: Error;
  /** Emit `text` (if any), then stall until the abort signal fires. */
  hang?: boolean;
}

function toV4Usage(inTok = 10, outTok = 5): LanguageModelV4Usage {
  return {
    inputTokens: { total: inTok, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outTok, text: undefined, reasoning: undefined },
  };
}

/** Wire-format input: objects are serialized, strings pass through (malformed stays malformed). */
function wireInput(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

export interface ScriptedModel extends LanguageModelV4 {
  /** Every call's full prompt (for assertions about what the model SAW) + tool names. */
  readonly calls: Array<{ messages: unknown[]; tools: string[] }>;
}

export function createMockModel(script: MockResponse[], label = 'mock'): ScriptedModel {
  let cursor = 0;
  const calls: ScriptedModel['calls'] = [];
  const next = (): MockResponse => {
    if (cursor >= script.length) throw new Error(`[${label}] script exhausted after ${script.length} responses`);
    return script[cursor++];
  };

  const textParts = (id: string, text: string): LanguageModelV4StreamPart[] => [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ];

  const toolCallParts = (tcs: NonNullable<MockResponse['toolCalls']>): LanguageModelV4StreamPart[] => {
    const out: LanguageModelV4StreamPart[] = [];
    for (let i = 0; i < tcs.length; i++) {
      const tc = tcs[i];
      const id = tc.toolCallId ?? `call-${cursor}-${i}`;
      const input = wireInput(tc.input);
      out.push({ type: 'tool-input-start', id, toolName: tc.toolName });
      out.push({ type: 'tool-input-delta', id, delta: input });
      out.push({ type: 'tool-input-end', id });
      out.push({ type: 'tool-call', toolCallId: id, toolName: tc.toolName, input });
    }
    return out;
  };

  return {
    specificationVersion: 'v4',
    provider: 'tiermux-poc',
    modelId: label,
    supportedUrls: {},
    calls,

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      calls.push({ messages: options.prompt, tools: (options.tools ?? []).map((t) => t.name) });
      const step = next();
      if (step.error) throw step.error;
      const content: LanguageModelV4GenerateResult['content'] = [];
      if (step.text !== undefined) content.push({ type: 'text', text: step.text });
      for (const tc of step.toolCalls ?? []) {
        content.push({ type: 'tool-call', toolCallId: tc.toolCallId ?? `call-${cursor}`, toolName: tc.toolName, input: wireInput(tc.input), providerExecuted: false });
      }
      const hasCalls = (step.toolCalls ?? []).length > 0;
      return {
        content,
        finishReason: { unified: hasCalls ? 'tool-calls' : 'stop', raw: hasCalls ? 'tool_calls' : 'stop' },
        usage: toV4Usage(),
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }> {
      calls.push({ messages: options.prompt, tools: (options.tools ?? []).map((t) => t.name) });
      const step = next();

      let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({ start(c) { controller = c; } });

      const finish = (unified: 'stop' | 'tool-calls' | 'error' = 'stop') => {
        controller.enqueue({
          type: 'finish',
          finishReason: { unified, raw: unified },
          usage: toV4Usage(),
        });
        controller.close();
      };

      if (step.error) {
        controller.error(step.error);
        return { stream };
      }

      controller.enqueue({ type: 'stream-start', warnings: [] });
      const textId = 'text-0';
      const tcs = step.toolCalls ?? [];

      // Reasoning (if scripted) always precedes text/tool calls — the provider-side order
      // reasoning models actually produce, so downstream ordering assertions are meaningful.
      if (step.reasoning) {
        const rid = 'reasoning-0';
        controller.enqueue({ type: 'reasoning-start', id: rid });
        controller.enqueue({ type: 'reasoning-delta', id: rid, delta: step.reasoning });
        controller.enqueue({ type: 'reasoning-end', id: rid });
      }

      if (tcs.length > 0) {
        // Text (if any) closes before the tool calls; tool calls end the response.
        if (step.text) for (const p of textParts(textId, step.text)) controller.enqueue(p);
        for (const p of toolCallParts(tcs)) controller.enqueue(p);
        finish('tool-calls');
        return { stream };
      }

      if (step.hang) {
        if (step.text) for (const p of textParts(textId, step.text)) controller.enqueue(p);
        const signal = options.abortSignal;
        if (signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return { stream };
        }
        const onAbort = () => controller.error(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', onAbort, { once: true });
        // No finish — the stream stays open until aborted.
        return { stream };
      }

      if (step.text) for (const p of textParts(textId, step.text)) controller.enqueue(p);
      finish('stop');
      return { stream };
    },
  };
}

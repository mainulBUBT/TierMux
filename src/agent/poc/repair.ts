// POC ONLY — v3 repair callback (plan §2). Replaces toolArgs.ts's 677-LOC regex ladder.
//
// Verified SDK semantics this builds on (ai@7.0.58, dist/index.js:3837-3910):
//   - parseToolCall validates the model's raw JSON input string against the tool's inputSchema.
//   - On failure it calls repairToolCall EXACTLY ONCE with the error
//     (NoSuchToolError | InvalidToolInputError) and the step's input messages.
//   - If repair returns null (or the repaired call is also invalid), the ORIGINAL call is
//     wrapped `invalid: true` and forwarded to execute() anyway — which is why the tools
//     defensively return { error } for unparseable input (Path A defense, plan §4).
//
// The repair asks the model itself to re-emit the call correctly:
//   - the correction prompt shows the model its own bad call, the error, and the tool's
//     JSON Schema (for invalid input) or the tool list (for an unknown tool);
//   - the inner streamText runs ONE step with execute-stripped tools, so the corrected
//     call is captured but never executed here — the outer loop executes it after
//     re-validation;
//   - a per-turn budget (3) stops a model that keeps re-emitting broken calls.

import {
  streamText,
  stepCountIs,
  InvalidToolInputError,
  NoSuchToolError,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { LanguageModelV4ToolCall } from '@ai-sdk/provider';

const REPAIR_BUDGET_PER_TURN = 3;

/** Tools without execute — the loop stops when one is called; nothing runs. The strip is
 *  structural (schema + description only), so the result needs a widening cast to ToolSet. */
function schemaOnly(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const { description, inputSchema } = t as { description?: unknown; inputSchema?: unknown };
      return [name, { ...(description !== undefined ? { description } : {}), inputSchema }];
    }),
  ) as unknown as ToolSet;
}

export interface RepairWithCount {
  repair: NonNullable<Parameters<typeof streamText>[0]['repairToolCall']>;
  /** How many repairs this turn has consumed (test hook). */
  count: () => number;
}

export function makeRepairViaModelSelfCorrection(ctx: { model: LanguageModel; signal?: AbortSignal }): RepairWithCount {
  let used = 0;

  const repair = async function repairViaModelSelfCorrection(args: {
    messages: ModelMessage[];
    toolCall: LanguageModelV4ToolCall;
    tools: ToolSet;
    inputSchema: (options: { toolName: string }) => PromiseLike<unknown>;
    error: unknown;
  }): Promise<LanguageModelV4ToolCall | null> {
    const { toolCall, tools, inputSchema, error, messages } = args;

    if (used >= REPAIR_BUDGET_PER_TURN) return null; // give up → SDK invalid-path takes over
    used++;

    const toolList = Object.keys(tools).map((n) => `- ${n}`).join('\n');
    const isNoSuch = NoSuchToolError.isInstance(error);
    const isInvalid = InvalidToolInputError.isInstance(error);

    // `messages` are the step's INPUT messages — the malformed assistant turn is not in
    // there — so the correction is appended, not spliced in.
    const correctionMessages: ModelMessage[] = [
      ...messages,
      {
        role: 'user',
        content:
          `Your previous tool call was malformed.\n\n` +
          `Tool called: ${toolCall.toolName}\n` +
          `Tool input: ${toolCall.input}\n` +
          `Error: ${(error as Error).message}\n\n` +
          (isNoSuch
            ? `This tool does not exist. Available tools:\n${toolList}\n\n` +
              `Pick the correct tool name and emit ONE valid tool call. No prose.`
            : isInvalid
              ? `Required JSON Schema for "${toolCall.toolName}":\n` +
                `${JSON.stringify(await Promise.resolve(inputSchema({ toolName: toolCall.toolName })).catch(() => ({})))}\n\n` +
                `Emit ONE valid tool call matching this schema. No prose.`
              : `Try again with ONE valid tool call. No prose.`),
      },
    ];

    const fix = await streamText({
      model: ctx.model,
      messages: correctionMessages,
      tools: schemaOnly(tools),        // capture only — the outer loop executes the repaired call
      stopWhen: [stepCountIs(1)],
      abortSignal: ctx.signal,
    });

    const steps = await fix.steps;
    const tc = steps.flatMap((s) => s.toolCalls ?? [])[0];
    if (!tc) return null;

    // Wire form: input back to the raw JSON string parseToolCall expects.
    const input = typeof (tc as { input?: unknown }).input === 'string'
      ? (tc as { input: string }).input
      : JSON.stringify((tc as { input?: unknown }).input);

    // Don't return a call that still doesn't parse — let the SDK's invalid path handle it.
    try {
      JSON.parse(input);
    } catch {
      return null;
    }
    return { ...toolCall, toolName: tc.toolName, input };
  };

  return { repair, count: () => used };
}

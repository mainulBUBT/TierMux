// Request compaction is Cline's (@cline/core's context pipeline, deterministic "basic"
// strategy — no extra model call). This file only adapts the runtime's prepareTurn context to
// the pipeline's input shape, which also wants apiMessages and the serving model's window.
import type { AgentRuntimePrepareTurnContext, AgentRuntimePrepareTurnResult } from '@cline/shared';
import type { ClineCoreModule } from './clineRuntime';

type PrepareTurn = (ctx: AgentRuntimePrepareTurnContext) => Promise<AgentRuntimePrepareTurnResult | undefined>;
type PipelineInput = Parameters<NonNullable<ReturnType<ClineCoreModule['createContextCompactionPrepareTurn']>>>[0];

export interface PrepareTurnOptions {
  /** 'off' keeps only the runtime's one overflow recovery; anything else also auto-compacts. */
  level: string;
  sessionId?: string;
  /** The serving model's context window, refined per request by onModel. */
  windowOf: () => number;
}

export function makePrepareTurn(core: ClineCoreModule, opts: PrepareTurnOptions): PrepareTurn | undefined {
  const compact = core.createContextCompactionPrepareTurn({
    providerId: 'tiermux',
    modelId: 'router',
    sessionId: opts.sessionId,
    compaction: { enabled: true, strategy: 'basic' },
  });
  if (!compact) return undefined;
  return async (ctx) => {
    if (opts.level === 'off' && !ctx.overflowRecovery) return undefined;
    const input = {
      agentId: ctx.agentId,
      conversationId: ctx.conversationId ?? '',
      parentAgentId: ctx.parentAgentId ?? null,
      iteration: ctx.iteration,
      messages: ctx.messages,
      apiMessages: ctx.messages,
      abortSignal: ctx.signal ?? new AbortController().signal,
      systemPrompt: ctx.systemPrompt ?? '',
      tools: [...ctx.tools],
      model: {
        id: ctx.model.id ?? 'router',
        provider: ctx.model.provider ?? 'tiermux',
        info: { ...ctx.model.info, id: ctx.model.id ?? 'router', contextWindow: opts.windowOf() },
      },
      overflowRecovery: ctx.overflowRecovery,
      previousRequestInputTokens: ctx.previousRequestInputTokens,
      emitStatusNotice: ctx.emitStatusNotice,
    } as unknown as PipelineInput;
    return (await compact(input)) as AgentRuntimePrepareTurnResult | undefined;
  };
}

/** The /compact command: Cline's compactor run once, in manual mode, over the stored transcript.
 *  Returns undefined when there was nothing to compact. */
export async function compactTranscript(
  core: ClineCoreModule,
  messages: readonly AgentRuntimePrepareTurnContext['messages'][number][],
  contextWindow: number,
): Promise<AgentRuntimePrepareTurnContext['messages'] | undefined> {
  const compact = core.createContextCompactionPrepareTurn(
    { providerId: 'tiermux', modelId: 'router', compaction: { enabled: true, strategy: 'basic' } },
    { mode: 'manual' },
  );
  if (!compact) return undefined;
  const input = {
    agentId: 'tiermux',
    conversationId: 'compact',
    parentAgentId: null,
    iteration: 0,
    messages,
    apiMessages: messages,
    abortSignal: new AbortController().signal,
    systemPrompt: '',
    tools: [],
    model: { id: 'router', provider: 'tiermux', info: { id: 'router', contextWindow } },
  } as unknown as PipelineInput;
  const out = await compact(input);
  return out?.messages as AgentRuntimePrepareTurnContext['messages'] | undefined;
}

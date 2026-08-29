// v3 subagent — isolated research and investigation agent.
// Spawns a bounded child agent loop with clean context and read-only research tools.
// Gathers facts from the codebase/web and returns a synthesized summary to the parent agent.
//
// Token savings: the sub-agent's full tool history is discarded — only the final synthesized
// answer (typically 200–400 tokens) is returned to the main agent's context.

import { streamText, stepCountIs, type ToolSet } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createRouterProvider } from './routerProvider';
import { createReadFileTool } from './tools/v3/readFile';
import { createListDirTool, createGlobTool, createGrepTool } from './tools/v3/search';
import { createGetDiagnosticsTool } from './tools/v3/getDiagnostics';
import { createWebSearchTool } from './tools/network/webSearch';
import { createFetchUrlTool } from './tools/network/fetchUrl';
import { diagLog } from '../../util/diag';

export interface SubagentOpts {
  task: string;
  context?: string;
  sessionId?: string;
  requestId?: string;
  abortSignal?: AbortSignal;
  /** Max sub-agent steps — default 8, capped at 15. */
  maxSteps?: number;
  /** Test seam: inject a model directly instead of routing through the live picker. */
  model?: LanguageModelV4;
}

export interface SubagentResult {
  summary: string;
  stepsCount: number;
}

const SUBAGENT_SYSTEM = `You are an autonomous research sub-agent in TierMux.
Your goal is to thoroughly investigate the workspace and answer the delegated task with precise, factual evidence.
- Explore the codebase using readFile, listDir, glob, grep, and diagnostics tools.
- Do NOT modify any files. You are strictly in research and analysis mode.
- When you have collected all required information, produce a clear, concise, and structured summary.
- Always include exact file paths, line numbers, and relevant code signatures/snippets where applicable.
- Keep the final summary focused on the delegated question. Do not pad with unnecessary context.`;

export async function runSubagent(opts: SubagentOpts): Promise<SubagentResult> {
  const maxSteps = Math.min(Math.max(1, opts.maxSteps ?? 8), 15);
  diagLog('subagent.start', `task="${opts.task.slice(0, 80)}" maxSteps=${maxSteps}`);

  const tools: ToolSet = {
    readFile: createReadFileTool(),
    listDir: createListDirTool(),
    glob: createGlobTool(),
    grep: createGrepTool(opts.abortSignal),
    getDiagnostics: createGetDiagnosticsTool(),
    webSearch: createWebSearchTool(),
    fetchUrl: createFetchUrlTool(),
  } as ToolSet;

  const model = opts.model ?? createRouterProvider({
    taskKind: 'debug',
    sessionId: opts.sessionId,
    requireTools: true,
  });

  const promptContent = opts.context
    ? `Task: ${opts.task}\n\nAdditional Context / Focus:\n${opts.context}`
    : `Task: ${opts.task}`;

  let textAccumulator = '';
  try {
    const result = streamText({
      model,
      system: SUBAGENT_SYSTEM,
      messages: [{ role: 'user', content: promptContent }],
      tools,
      stopWhen: [stepCountIs(maxSteps)],
      abortSignal: opts.abortSignal,
      maxRetries: 1,
      onChunk: ({ chunk }) => {
        if (chunk.type === 'text-delta') {
          textAccumulator += chunk.text;
        }
      },
    });

    const steps = await result.steps;
    const stepsCount = steps.length;
    // Only the LAST step's text is the synthesis; intermediate-step narration stays out of the
    // parent's context (the point of delegation). The streamed accumulator is the fallback for
    // a stream that errored mid-flight (the steps promise can reject — reset doc invariant 6).
    const lastStepText = stepsCount ? (steps[stepsCount - 1].text ?? '').trim() : '';
    const finalAnswer = lastStepText || textAccumulator.trim() || (await result.text).trim();

    diagLog('subagent.finish', `steps=${stepsCount} summaryLen=${finalAnswer.length}`);
    return {
      summary: finalAnswer || 'Sub-agent completed the investigation without additional notes.',
      stepsCount,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagLog('subagent.error', `error=${msg}`);
    return {
      summary: `Sub-agent investigation stopped early: ${msg}`,
      stepsCount: 0,
    };
  }
}

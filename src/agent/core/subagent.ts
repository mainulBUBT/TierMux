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
import { createRunCommandTool } from './tools/v3/runCommand';
import { diagLog } from '../../util/diag';
import { METHOD } from '../../context/system';
import { loadAgents, type AgentDef } from '../agents';
import { effectiveRootUri } from './tools/workspaceRoot';

export interface SubagentOpts {
  task: string;
  context?: string;
  sessionId?: string;
  requestId?: string;
  abortSignal?: AbortSignal;
  /** Registry name of the agent to run (see agents.ts); defaults to `explore`. */
  agent?: string;
  /** Max sub-agent steps — default 8, capped at 15. */
  maxSteps?: number;
  /** Test seam: inject a model directly instead of routing through the live picker. */
  model?: LanguageModelV4;
}

export interface SubagentResult {
  summary: string;
  stepsCount: number;
  /** Which registry agent ran — the caller labels its report with it. */
  agent: string;
}



/** Tool factories a sub-agent may be given, by name. Nothing that mutates: a sub-agent has no
 *  approval flow (AI SDK caveat), so every tool here must be safe to run unattended. */
function subagentTools(opts: SubagentOpts, names?: string[]): ToolSet {
  const all: ToolSet = {
    readFile: createReadFileTool(),
    listDir: createListDirTool(),
    glob: createGlobTool(),
    grep: createGrepTool(opts.abortSignal),
    getDiagnostics: createGetDiagnosticsTool(),
    webSearch: createWebSearchTool(),
    fetchUrl: createFetchUrlTool(),
    runCommand: createRunCommandTool({ abortSignal: opts.abortSignal, sessionId: opts.sessionId, requestId: opts.requestId, readOnly: true }),
  } as ToolSet;
  if (!names?.length) return all;
  const picked: ToolSet = {};
  for (const n of names) if (all[n]) picked[n] = all[n];
  // An agent file naming only unknown tools would otherwise run blind.
  return Object.keys(picked).length ? picked : all;
}

/** Test seam: the model every sub-agent run uses when the caller supplies none — lets an e2e
 *  exercise a HOST-invoked sub-agent (the todo audit) without a provider. Production never sets it. */
let subagentModelOverride: LanguageModelV4 | undefined;
export function __setSubagentModelForTests(m: LanguageModelV4 | undefined): void {
  subagentModelOverride = m;
}

/** The agent definition to run: the named one, else `explore`, else the first built-in. */
export function resolveAgent(name?: string): AgentDef {
  let root: string | undefined;
  try { root = effectiveRootUri().fsPath; } catch { /* headless */ }
  const agents = loadAgents(root);
  return agents.get((name ?? 'explore').toLowerCase()) ?? agents.get('explore') ?? [...agents.values()][0];
}

export async function runSubagent(opts: SubagentOpts): Promise<SubagentResult> {
  const def = resolveAgent(opts.agent);
  const maxSteps = Math.min(Math.max(1, opts.maxSteps ?? def.maxSteps ?? 8), 15);
  diagLog('subagent.start', `agent=${def.name} task="${opts.task.slice(0, 80)}" maxSteps=${maxSteps}`);

  const tools = subagentTools(opts, def.tools);

  const model = opts.model ?? subagentModelOverride ?? createRouterProvider({
    taskKind: def.taskKind ?? 'debug',
    pinnedModel: def.model,
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
      system: `${def.prompt}\n\n${METHOD}`,
      messages: [{ role: 'user', content: promptContent }],
      tools,
      temperature: 0.2,
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
      agent: def.name,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagLog('subagent.error', `error=${msg}`);
    return {
      summary: `Sub-agent investigation stopped early: ${msg}`,
      stepsCount: 0,
      agent: def.name,
    };
  }
}

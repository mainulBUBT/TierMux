// v3 repair callback. SDK semantics (ai@7.0.58): parseToolCall validates the raw input; on failure
// repairToolCall runs EXACTLY ONCE; if it returns null the call is marked invalid and NOT executed
// — the model gets a tool-error part (corrected 2026-09-05; this header once claimed otherwise,
// which is why some tools grew runtime clamps duplicating their zod schema). The repair shows the
// model its bad call, the error and the tool's JSON Schema (or the tool list), runs ONE step with
// execute-stripped tools so the corrected call is captured not executed, and a per-turn budget of
// 3 stops a model that keeps re-emitting broken calls.

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

/** What other harnesses call the same tool. Skills, agent files and pasted instructions are
 *  written for whichever agent their author used — nobody writes them for TierMux — so a model
 *  following them emits `Read`, `Bash` or `apply_patch`. Mapping the name costs nothing; the
 *  alternative is a model round-trip per mistaken call. Keys are normalized (lowercased,
 *  non-alphanumerics stripped), so `WebFetch`, `web_fetch` and `web-fetch` all land here. */
const TOOL_ALIASES: Record<string, string> = {
  read: 'readFile', view: 'readFile', viewfile: 'readFile', cat: 'readFile', openfile: 'readFile',
  strreplaceeditor: 'editFile', strreplacebasededittool: 'editFile', applypatch: 'editFile',
  edit: 'editFile', editor: 'editFile', replaceinfile: 'editFile', multiedit: 'editFile',
  write: 'writeFile', create: 'writeFile', createfile: 'writeFile', writetofile: 'writeFile',
  delete: 'deleteFile', deletefile: 'deleteFile', removefile: 'deleteFile', rm: 'deleteFile',
  bash: 'runCommand', shell: 'runCommand', run: 'runCommand', terminal: 'runCommand',
  executecommand: 'runCommand', runterminalcommand: 'runCommand', command: 'runCommand',
  search: 'grep', searchfiles: 'grep', ripgrep: 'grep', rg: 'grep', grepsearch: 'grep', codebasesearch: 'grep',
  globfiles: 'glob', findfiles: 'glob', find: 'glob', filesearch: 'glob',
  ls: 'listDir', list: 'listDir', listfiles: 'listDir', listdirectory: 'listDir', dir: 'listDir',
  task: 'delegateTask', newtask: 'delegateTask', delegate: 'delegateTask', subagent: 'delegateTask',
  agent: 'delegateTask', spawnagent: 'delegateTask', explore: 'delegateTask',
  webfetch: 'fetchUrl', fetch: 'fetchUrl', fetchurl: 'fetchUrl', readurl: 'fetchUrl', browser: 'fetchUrl',
  websearch: 'webSearch', searchweb: 'webSearch',
  updateplan: 'todoWrite', todo: 'todoWrite', todos: 'todoWrite', writetodos: 'todoWrite', plan: 'todoWrite',
  askfollowupquestion: 'askUser', askuserquestion: 'askUser', question: 'askUser', ask: 'askUser',
  diagnostics: 'getDiagnostics', problems: 'getDiagnostics', getproblems: 'getDiagnostics', lint: 'getDiagnostics',
};

/** The offered tool this name most likely meant, or undefined. Exact matches never reach here
 *  (the SDK would have dispatched them); a name that differs only in case or separators is
 *  resolved first, then the cross-harness alias table. */
export function resolveToolAlias(called: string, offered: string[]): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(called);
  if (!target) return undefined;
  const sameShape = offered.find((o) => norm(o) === target);
  if (sameShape) return sameShape;
  const alias = TOOL_ALIASES[target];
  return alias && offered.includes(alias) ? alias : undefined;
}

/** Input with top-level null-valued keys removed; undefined when there is nothing to fix. */
export function withoutNullKeys(input: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] === null);
  if (keys.length === 0) return undefined;
  for (const k of keys) delete obj[k];
  return JSON.stringify(obj);
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

    // No-model first pass: a tool named the way some other harness names it.
    if (NoSuchToolError.isInstance(error)) {
      const real = resolveToolAlias(toolCall.toolName, Object.keys(tools));
      if (real) return { ...toolCall, toolName: real };
    }

    // No-model first pass: weak models send `null` for an unset optional param, which zod rejects.
    if (InvalidToolInputError.isInstance(error)) {
      const stripped = withoutNullKeys(toolCall.input);
      if (stripped !== undefined) return { ...toolCall, input: stripped };
    }

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

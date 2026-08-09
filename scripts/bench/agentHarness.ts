/* Run one benchmark query through the REAL agent loop, headlessly, and record what it did.
 *
 * The router benchmark (runBench.ts) calls router.route() with a bare message: no tools, no
 * workspace, so it can measure latency but not retrieval. This harness instead calls
 * runTurn() — the same entry point chatViewProvider uses — so the real tool set runs against a
 * real checkout and the tool trace becomes the evidence retrieval is scored from.
 *
 * Read-only by construction: every query runs in 'ask' or 'plan' mode, which build the
 * read-only tool set (readFile/listDir/glob/grep/explore/web), so a benchmark run can never
 * edit the project it is measuring. That also means no CommandGate/EditGate wiring is needed.
 *
 * Requires the real-fs vscode shim: `node -r ./scripts/bench/benchVscode.cjs …`.
 */
import * as path from 'path';
import { runTurn } from '../../src/agent/core/loop';
import { WorkspaceIndex } from '../../src/indexer/WorkspaceIndex';
import { setWorkspaceIndex } from '../../src/agent/core/tools/indexAccess';
import type { Router } from '../../src/router/router';
import type { AgentOpts, ToolEvent } from '../../src/agent/agent';
import type { ChatMessage } from '../../src/shared/types';
import type { QualityMode, QualityQuery, TraceEntry } from './qualityTypes';

/** extension.ts wires the symbol/dependency index at activation; a bench run never activates the
 *  extension, so `getSymbolGraph`/`getDependencyTree` threw "WorkspaceIndex not initialized." on
 *  every call — the 2026-08-09 baseline measured an agent whose symbol tools were 100% broken,
 *  which real users do not have. Mirror the activation wiring here so the bench measures the
 *  same tool set the product ships. Config defaults match extension.ts. */
let indexReady = false;
function ensureWorkspaceIndex(): void {
  if (indexReady) return;
  indexReady = true;
  try {
    setWorkspaceIndex(new WorkspaceIndex(() => ({ enabled: true, maxFiles: 5000, excludes: [] })));
  } catch (e) {
    console.warn(`[bench] workspace index unavailable — symbol tools will error: ${(e as Error).message}`);
  }
}

/** Tools whose calls count as "retrieval" for the grep-fallback metric. `explore` is retrieval
 *  too — it is a sub-agent that reads and greps on the caller's behalf. */
const RETRIEVAL_TOOLS = new Set(['readFile', 'listDir', 'glob', 'grep', 'explore']);

/** Pull workspace-relative paths out of a tool call's arguments. Each retrieval tool spells its
 *  path argument differently, and readFile's may be an array (batched read). */
function pathsFromArgs(name: string, args: unknown): string[] {
  const a = (args ?? {}) as { path?: unknown; pattern?: unknown; glob?: unknown };
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(normalizePath(v.trim()));
  };
  if (name === 'readFile' || name === 'listDir') {
    if (Array.isArray(a.path)) a.path.forEach(push);
    else push(a.path);
  } else if (name === 'grep') {
    // grep's `path` scopes the search; without one it swept the whole workspace, which is
    // exactly the "fallback" case — record no path rather than a fake one.
    push(a.path);
  } else if (name === 'glob') {
    push(a.pattern);
  }
  return out;
}

/** Strip a leading "./" and absolute workspace prefix so trace paths compare against dataset
 *  ground truth (which is always workspace-relative, forward-slashed). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Files a grep/glob call actually HIT, recovered from its output. Retrieval must count these:
 *  an agent that greps for a symbol and gets the right file back has found it, even though the
 *  path never appeared in the call's arguments. Both tools emit paths at line starts. */
function pathsFromOutput(name: string, output: string): string[] {
  if (name !== 'grep' && name !== 'glob' && name !== 'explore') return [];
  const out = new Set<string>();
  for (const line of output.split('\n')) {
    // grep: "src/foo/bar.ts:42:  match text"   glob: "src/foo/bar.ts"
    // explore: prose, but cites paths inline — match anything file-shaped with a known-ish ext.
    const m = /(?:^|[\s"'`(])((?:[\w.@-]+\/)+[\w.-]+\.[a-zA-Z]{1,5})/g;
    let hit: RegExpExecArray | null;
    while ((hit = m.exec(line)) !== null) out.add(normalizePath(hit[1]));
    if (out.size > 400) break; // a huge glob dump adds nothing but memory pressure
  }
  return [...out];
}

export interface AgentRunOutcome {
  ok: boolean;
  answer: string;
  selectedModel: string;
  latencyMs: number;
  trace: TraceEntry[];
  /** Files the agent deliberately opened: a readFile/listDir target, or a path it scoped a
   *  grep to. Strong evidence it went looking for that file. */
  openedFiles: string[];
  /** Files that only appeared in a search result the agent read past. One broad grep produces
   *  a hundred of these, so they are weaker evidence and scored differently. */
  seenFiles: string[];
  errorMessage: string | null;
}

export interface RunQueryOpts {
  mode: QualityMode;
  /** 'auto' or a pinned 'platform::modelId' — pinning is what makes before/after runs
   *  comparable, since Auto could otherwise pick a different model per run. */
  model: string;
  timeoutMs: number;
}

/** Set the workspace the tools operate on. Must be called before the first runTurn(). */
export function setWorkspaceRoot(root: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const fsPath = path.resolve(root);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath, path: fsPath }, name: path.basename(fsPath), index: 0 }];
  // After workspaceFolders exists — the index resolves its root from it.
  ensureWorkspaceIndex();
}

export async function runQuery(router: Router, q: QualityQuery, opts: RunQueryOpts): Promise<AgentRunOutcome> {
  const trace: TraceEntry[] = [];
  const opened = new Set<string>();
  const seen = new Set<string>();
  // toolCallId → index in `trace`, so the 'done' event can attach output size/paths to the
  // entry the 'running' event created instead of double-counting the call.
  const byCallId = new Map<string, number>();

  const onTool = (e: ToolEvent) => {
    if (e.state === 'running') {
      const paths = pathsFromArgs(e.name, e.args);
      paths.forEach((p) => opened.add(p));
      const a = (e.args ?? {}) as { offset?: unknown; limit?: unknown };
      byCallId.set(e.toolCallId, trace.length);
      trace.push({
        name: e.name,
        paths,
        ...(e.name === 'readFile' ? { windowed: a.offset != null || a.limit != null } : {}),
        outputChars: 0,
      });
      return;
    }
    if (e.state !== 'done' && e.state !== 'error') return;
    const idx = byCallId.get(e.toolCallId);
    if (idx === undefined) return;
    const entry = trace[idx];
    const output = e.detail ?? '';
    entry.outputChars = output.length;
    if (e.state === 'error') {
      entry.error = output.slice(0, 300);
      return;
    }
    // Mirrors the notice createReadTool appends when a file is longer than the returned window
    // ("…[showing lines 1–800 of 2431. Read again with offset=801 for more.]").
    if (e.name === 'readFile' && /\[showing lines \d+[–-]\d+ of \d+/.test(output)) entry.pagedOut = true;
    const hits = pathsFromOutput(e.name, output).filter((p) => !entry.paths.includes(p));
    if (hits.length) {
      hits.forEach((p) => seen.add(p));
      entry.hits = hits;
    }
  };

  const messages: ChatMessage[] = [
    ...(q.context ?? []).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: 'user', content: q.query },
  ];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  const start = Date.now();
  let selectedModel = '';

  const agentOpts: AgentOpts = {
    messages,
    mode: opts.mode,
    effort: 'medium',
    abortSignal: ac.signal,
    ...(opts.model !== 'auto' ? { pinnedModel: opts.model } : {}),
    onChunk: () => {},
    onTool,
    onReasoning: () => {},
    onModel: (platform, model) => { selectedModel = `${platform}::${model}`; },
    onFailover: () => {},
    onStep: () => {},
    onTodos: () => {},
    // No human is watching: answering "" leaves the model to proceed on its own assumptions,
    // which is the behaviour we want to measure rather than a hang.
    onAskUser: async () => '',
    onError: () => {},
  };

  try {
    const result = await runTurn(router, agentOpts);
    clearTimeout(timer);
    const answer = (result.text ?? '').trim();
    return {
      // A turn that errored, produced no text, or was killed by a guardrail is not a scorable
      // answer — mark it failed so it counts as 0 rather than being silently judged on ''.
      ok: !result.failed && answer.length > 0,
      answer,
      selectedModel: selectedModel || `${result.platform ?? '?'}::${result.model ?? '?'}`,
      latencyMs: Date.now() - start,
      trace,
      openedFiles: [...opened],
      seenFiles: [...seen],
      errorMessage: result.failed
        ? (result.errorMessage ?? 'turn failed')
        : answer
          ? null
          : (result.stopReason ? `stopped: ${result.stopReason}` : 'empty answer'),
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      answer: '',
      selectedModel,
      latencyMs: Date.now() - start,
      trace,
      openedFiles: [...opened],
      seenFiles: [...seen],
      errorMessage: ac.signal.aborted ? `timeout after ${opts.timeoutMs}ms` : (e as Error).message,
    };
  }
}

export { RETRIEVAL_TOOLS };

// Toolset budget: small context windows get an ESSENTIAL-ONLY tool set (2026-08-25).
//
// The full agent set is 22 tools ≈ 6.3k tokens of schema — 20–40% of the 16–32k free-tier
// windows this extension routes to, before a single message (same family as the
// overhead-aware prune budget). Small-context agents across the ecosystem stay viable by
// keeping the tool surface small (Cline ~10 tools; aider none — signature repo-map instead),
// so below SMALL_WINDOW_TOOLS_LIMIT the model is offered the minimal navigate→edit→verify
// loop plus the protocol tools the prompts reference by name.
//
// Covers:
//   1. Boundary: < 40k → essential; ≥ 40k / undefined / 0 → full (safe default).
//   2. Per-mode essential sets (agent / plan / ask) — exact membership, intersection-only.
//   3. Schema cost actually drops hard (small ≤ 60% of full).
//   4. Wire-level proof: runTurn with a scripted router — the provider request carries 10
//      tool schemas on a 16k window and the full 22 on a 128k one.
//
// Run: npm run test:e2e:toolset-budget
import { createToolSet, SMALL_WINDOW_TOOLS_LIMIT, isSmallToolsetWindow } from '../src/agent/core/tools';
import { getMcpManager } from '../src/agent/core/tools/mcp/manager';
import type { AgentMode } from '../src/agent/agent';
import type { Router } from '../src/router/router';

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

const baseOpts = (mode: AgentMode) => ({
  mode, onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
  onFailover: () => {}, onStep: () => {}, onTodos: () => {}, onAskUser: async () => '',
  onError: () => {}, messages: [],
} as never as Parameters<typeof createToolSet>[0]);

const routerStub = {} as Router;
const tokens = (t: object): number => Math.ceil(JSON.stringify(t).length / 4);

// ── 1. Boundary ────────────────────────────────────────────────────────────────────────
ok('window below the limit → essential', isSmallToolsetWindow(SMALL_WINDOW_TOOLS_LIMIT - 1));
ok('window at/above the limit → full set', !isSmallToolsetWindow(SMALL_WINDOW_TOOLS_LIMIT) && !isSmallToolsetWindow(128_000));
ok('unknown/zero window → full set (safe default)', !isSmallToolsetWindow(undefined) && !isSmallToolsetWindow(0));

// ── 2. Per-mode membership ─────────────────────────────────────────────────────────────
{
  const full = createToolSet(baseOpts('agent'), getMcpManager(), routerStub, 128_000);
  const small = createToolSet(baseOpts('agent'), getMcpManager(), routerStub, 16_384);
  const names = Object.keys(small).sort();
  ok('agent small: exactly the 10 essential tools',
    names.join(',') === 'editFile,getDiagnostics,glob,grep,listDir,question,readFile,runCommand,todowrite,writeFile',
    names.join(','));
  ok('agent small: no fleet/web/graph/subagent tools leaked in',
    !['implementPipeline', 'delegate', 'explore', 'webSearch', 'deepSearch', 'fetchUrl', 'checkUrl', 'getSymbolGraph', 'getDependencyTree', 'createFile', 'deleteFile', 'remember'].some((n) => n in small));
  ok('agent small ⊂ agent full (intersection only)', Object.keys(small).every((n) => n in full));
  ok('agent full still offers the big set (22 tools)', Object.keys(full).length >= 22, `${Object.keys(full).length} tools`);
}
{
  const small = createToolSet(baseOpts('plan'), getMcpManager(), routerStub, 16_384);
  ok('plan small: askQuestions survives (mode-critical clarify channel)', 'askQuestions' in small);
  ok('plan small: no mutating tools', !['writeFile', 'createFile', 'editFile', 'deleteFile'].some((n) => n in small));
  ok('plan small: read/navigate/verify core present', ['readFile', 'grep', 'glob', 'runCommand'].every((n) => n in small));
}
{
  const small = createToolSet(baseOpts('ask'), getMcpManager(), routerStub, 16_384);
  ok('ask small: read-only core only', Object.keys(small).sort().join(',') === 'glob,grep,listDir,readFile,runCommand',
    Object.keys(small).sort().join(','));
}

// ── 3. Schema cost actually drops ──────────────────────────────────────────────────────
{
  const full = tokens(createToolSet(baseOpts('agent'), getMcpManager(), routerStub, 128_000));
  const small = tokens(createToolSet(baseOpts('agent'), getMcpManager(), routerStub, 16_384));
  ok(`schema cost: small ≤ 60% of full (${small} vs ${full} tokens)`, small <= full * 0.6);
  ok(`schema cost: full set still > 6k tokens (the weight being cut)`, full > 6_000);
}

// ── 4. Wire-level proof through runTurn ────────────────────────────────────────────────
async function wireToolCount(contextWindow: number): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-var-extraneous-dependencies
  const { runTurn } = await import('../src/agent/core/loop');
  let toolCount = -1;
  const baseResponse = (o: Record<string, unknown>) => ({
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...o } }],
  });
  const fakeRouter = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async route(_m: unknown, opts: any) {
      toolCount = Array.isArray(opts?.tools) ? opts.tools.length : -1;
      return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Done.' }) };
    },
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1, contextWindow } }),
  } as unknown as Router;
  await runTurn(fakeRouter, {
    messages: [{ role: 'user', content: 'say hi' }], mode: 'agent', effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
    onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return toolCount;
}

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd(), path: process.cwd() } }];

  const smallWire = await wireToolCount(16_384);
  ok(`wire: 16k window serves the 10-tool essential set`, smallWire === 10, `${smallWire} tools`);
  const fullWire = await wireToolCount(128_000);
  ok(`wire: 128k window serves the full set`, fullWire >= 22, `${fullWire} tools`);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();

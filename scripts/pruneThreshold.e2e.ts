// Prune threshold seam: with NO explicit tiermux.agent.pruneAtTokens, the adaptive default
// fires when MESSAGES reach (85% of the routed model's window − the measured system+tools
// overhead), not the old 40% of the window and not the bare 85% — the request carries the
// tool schemas alongside the messages, so a message-only budget let small/medium windows
// overflow before pruning fired (2026-08-25 "loses context mid-turn" repro). Live runTurn
// seam with a scripted router (the reanchor harness pattern): one ~8k-token read must NOT
// trigger pruning, a crowd of them must.
//
// Run:  npm run test:e2e:prune-threshold
async function seam(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const { runTurn } = await import('../src/agent/core/loop');
  const { setGates } = await import('../src/agent/core/tools/gates');
  const { CommandGate } = await import('../src/edits/commandGate');
  const { EditGate } = await import('../src/edits/applyEdit');
  const { ANCHOR_BLOCK_MARKER } = await import('../src/agent/core/anchors');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-prune-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];
  setGates(new EditGate(() => false) as never, new CommandGate(() => 'always', () => 5000, () => []) as never);

  // One read ≈ 7.5k tokens: readFile caps at 800 lines AND 30k chars, so make lines long
  // enough that the 800-line page overflows the char cap (45 chars × 800 ≈ 36k → capped 30k
  // ≈ 7.5k tokens). One read < 13600 target (no prune); two reads ≈ 15k cross it.
  fs.writeFileSync(path.join(root, 'big.ts'), `${'export const filler = 0xABCDEF12; // pad\n'.repeat(800)}`);

  let failures = 0;
  const ok = (name: string, cond: boolean, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
    if (!cond) failures++;
  };

  const run = async (contextWindow: number): Promise<string[][]> => {
    (globalThis as never as Record<string, unknown>).__tiermuxTestConfig = {
      mixturePipeline: 'off',
      reanchorChars: 6000,
      verifyCommand: 'off',
      // NO pruneAtTokens override — the adaptive default is what's under test.
    };
    const seen: string[][] = [];
    let calls = 0;
    const baseResponse = (o: Record<string, unknown>) => ({
      id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...o } }],
    });
    const fakeRouter = {
      async route(messages: Array<{ role: string; content: unknown }>) {
        seen.push(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
        calls++;
        if (calls <= 4) {
          return {
            platform: 'custom' as const, model: 'fake',
            // DISTINCT arguments per read — identical repeats would trip stuckStop (exact
            // repeat x3) before the 85% target is ever reached, ending the turn on the wrong path.
            response: baseResponse({ tool_calls: [{ id: `c${calls}`, type: 'function' as const, function: { name: 'readFile', arguments: JSON.stringify({ path: 'big.ts', offset: calls }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'done' }) };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1, contextWindow } }),
    };
    await runTurn(fakeRouter as never, {
      messages: [{ role: 'user', content: 'explain big.ts' }],
      mode: 'agent', effort: 'medium',
      onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
      onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    } as never);
    return seen;
  };

  // 32k window: profile.pruneTarget = 27888. The window is under the 40k essential-toolset
  // limit, so the request carries the 10-tool set (~3.2k tokens) instead of all 22 (~6.3k) —
  // message budget ≈ 27888 − ~3.5k ≈ 24.4k. Each capped read ≈ 7.8k wire tokens: three reads
  // (~23k) stay under — NO prune; four reads (~31k) cross the budget → prune + re-anchor.
  // (The two fixes work together: the essential set FREED ~3.1k tokens of window, which the
  // overhead-aware budget hands straight back to the transcript.)
  const seen = await run(32_768);
  const tok = (arr: string[]): number => Math.ceil(arr.reduce((n, c) => n + c.length, 0) / 4);
  console.log('   measured tokens per call:', seen.map((m) => tok(m)).join(', '), '(message budget ≈ 27888 − ~3.5k essential-set overhead)');
  // The system prompt mentions the <tiermux-context> TAG literally (semantics line), so match
  // the anchor MARKER instead — only a real injected digest carries it.
  const hasBlock = (i: number): boolean => (seen[i] ?? []).some((c) => c.includes(ANCHOR_BLOCK_MARKER));
  const first = seen.findIndex((_, i) => hasBlock(i));
  ok('early reads survive un-pruned (three big reads still under the overhead-aware budget)', first >= 4, `first block at call ${first}`);
  ok('once reads crowd the window-minus-overhead the prune cascade fires → re-anchor block injected', first === 4, `first block at call ${first}`);

  // 8k window (Gemma-2-27B class — a real catalog entry): fraction target 6963 minus the
  // essential-set overhead (~3.5k) leaves a ~3.5k message budget, so the FIRST big read
  // already exceeds it and the cascade fires immediately. The OLD code targeted 12k on this
  // 8k window (floor above the window) — messages were allowed to grow past the window itself
  // before pruning ever fired; the provider silently truncated the middle of the conversation.
  const seen8k = await run(8_192);
  const hasBlock8k = (i: number): boolean => (seen8k[i] ?? []).some((c) => c.includes(ANCHOR_BLOCK_MARKER));
  const first8k = seen8k.findIndex((_, i) => hasBlock8k(i));
  ok('8k window: pruning starts immediately (old 12k floor > window meant it started only after overflow)', first8k === 1, `first block at call ${first8k}`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void seam();

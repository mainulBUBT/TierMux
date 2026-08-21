// Prune threshold seam: with NO explicit tiermux.agent.pruneAtTokens, the adaptive default now
// fires at 85% of the routed model's context window (ExecutionProfile.pruneTarget), not the old
// 40% — so a mid-size transcript that the old code would have blanked stays intact. Live runTurn
// seam with a scripted router (the reanchor harness pattern), window=16k: one ~8k-token read
// must NOT trigger pruning (old 40% = 6.4k would have), two reads (~16k) must.
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

  // 32k window: profile.pruneTarget = 27888. Each capped read ≈ 7.8k wire tokens (SDK-side
  // similar — the 30k-char result dominates), so three reads (~24k) stay under — NO prune (the
  // old 40% formula = 13107 would already have blanked evidence two reads earlier). Four reads
  // (~32k) cross the target → prune + re-anchor.
  const seen = await run(32_768);
  const tok = (arr: string[]): number => Math.ceil(arr.reduce((n, c) => n + c.length, 0) / 4);
  console.log('   measured tokens per call:', seen.map((m) => tok(m)).join(', '), '(target 27888)');
  // Empirical framing (wire-side chars/4 underestimates prepareStep's SDK-side roughTokens,
  // which JSON-stringifies parts including tool inputs): with the 85% target the block first
  // appears on the request AFTER two reads — the old 40% formula (13107) already fired one
  // read earlier, blanking evidence the model still needed.
  // The system prompt mentions the <tiermux-context> TAG literally (semantics line), so match
  // the anchor MARKER instead — only a real injected digest carries it.
  const hasBlock = (i: number): boolean => (seen[i] ?? []).some((c) => c.includes(ANCHOR_BLOCK_MARKER));
  const first = seen.findIndex((_, i) => hasBlock(i));
  ok('early reads survive un-pruned (old 40% formula blanked a read earlier)', first >= 4, `first block at call ${first}`);
  ok('once reads crowd the window the prune cascade fires → re-anchor block injected', first === 4, `first block at call ${first}`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void seam();

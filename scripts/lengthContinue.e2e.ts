/* A reply cut off by the output-token budget (finish_reason "length") must get exactly ONE
 * mechanical continuation pass, and the shipped answer must be BOTH halves.
 *
 * Live repro (2026-08-30, Cloudflare @cf/deepseek-ai/deepseek-r1-distill-qwen-32b, two turns
 * in one session): each reply cut mid-sentence ("…making sure to cite the specific files and
 * lines where I"), finish 'length', 2m24s — the distill burned its whole output budget on
 * think-style narration before the answer began. AI SDK v7 (unlike v4's `continueSteps`)
 * never continues a 'length' step on its own, and engine.ts's act/report-gap nudge fires only
 * on 'stop', so the cut answer used to ship truncated with nothing behind it.
 *
 * Locks the one-continuation invariant too: a second 'length' in a row must NOT grow a ladder.
 *
 * Run: npm run test:e2e:length-continue
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from '../src/agent/poc/mockModel';
import { runAgentStream, runAskStream } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import type { AgentOpts, AgentResult } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-len-'));

function opts(over: Partial<AgentOpts>): AgentOpts {
  return {
    messages: [{ role: 'user', content: 'list the unused pages in the app' }],
    mode: 'ask', effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
    onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    onAskUser: async () => 'yes', onError: () => {},
    ...over,
  } as AgentOpts;
}

async function turn(model: ReturnType<typeof createMockModel>, over: Partial<AgentOpts> = {},
  entry = runAskStream): Promise<AgentResult> {
  __setEngineModelForTests(model);
  try { return await runWithWorkspaceRoot(root, () => entry(undefined as never, opts(over))); }
  finally { __setEngineModelForTests(undefined); }
}

async function main() {
  console.log('— the 2026-08-30 repro shape: length cut mid-sentence —');
  {
    const m = createMockModel([
      { text: 'The unused pages are admin.php and', finish: 'length' },
      { text: ' settings/legacy.php. Nothing else is unreferenced.' },
    ], 'length-cut');
    const r = await turn(m);
    ok('exactly one continuation pass ran', m.calls.length === 2, `${m.calls.length} model calls`);
    ok('the shipped answer is BOTH halves', r.text.includes('admin.php and') && r.text.includes('legacy.php'), r.text.slice(0, 90));
    ok('the nudge told it to continue, not restart', /cut off mid-sentence/i.test(JSON.stringify(m.calls[1]?.messages ?? '')));
    ok('final finish reason is the completing pass', r.finishReason === 'stop', r.finishReason);
  }

  console.log('\n— a second length cut must not grow a ladder —');
  {
    const m = createMockModel([
      { text: 'half one,', finish: 'length' },
      { text: ' half two,', finish: 'length' },
    ], 'length-twice');
    const r = await turn(m);
    ok('still exactly ONE continuation (2 calls)', m.calls.length === 2, `${m.calls.length} model calls`);
    ok('both halves still stitch', r.text.includes('half one,') && r.text.includes('half two,'), r.text);
    ok('the cut is reported honestly', r.finishReason === 'length', r.finishReason);
  }

  console.log('\n— a complete answer is never continued —');
  {
    const m = createMockModel([{ text: 'Every page is referenced; no unused pages.' }], 'clean-stop');
    const r = await turn(m);
    ok('a stop-finished answer ships untouched', m.calls.length === 1, `${m.calls.length} model call`);
    ok('verbatim', r.text.includes('no unused pages'), r.text);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nLength continuation holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

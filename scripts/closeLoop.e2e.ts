/* A turn that ran tools and then ANNOUNCED its next tool call instead of making it must get
 * the same one continuation an empty synthesis gets.
 *
 * Two live repros, same shape, same model (Kilo/stepfun/step-3.7-flash:free, 2026-08-30):
 *   3:47 PM — 8 tool uses, ended on "Let me continue reading from where it was cut off…"
 *   3:54 PM — 6 tool uses, ended on "Let me continue reading the PlaceNewOrder trait…"
 * 173 out tokens, no answer, the task untouched. The second is AFTER the readFile paging fix,
 * so the tool was no longer withholding an offset — the model just stops at the narration.
 *
 * It fell through both existing gaps: actGap requires that no tool ran, reportGap required an
 * empty reply. This locks the third quadrant, and — just as importantly — locks the cases that
 * must NOT be nudged, so the guard stays one guard instead of growing into the tower the
 * SIMPLE_CORE_RESET removed.
 *
 * Run: npm run test:e2e:close-loop
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-loop-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'hello');

function opts(over: Partial<AgentOpts>): AgentOpts {
  return {
    messages: [{ role: 'user', content: 'trace how an order is placed' }],
    mode: 'agent', effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
    onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    onAskUser: async () => 'yes', onError: () => {},
    ...over,
  } as AgentOpts;
}

async function turn(model: ReturnType<typeof createMockModel>, over: Partial<AgentOpts> = {},
  entry = runAgentStream): Promise<AgentResult> {
  __setEngineModelForTests(model);
  try { return await runWithWorkspaceRoot(root, () => entry(undefined as never, opts(over))); }
  finally { __setEngineModelForTests(undefined); }
}

const readCall = { toolCalls: [{ toolName: 'readFile', input: { path: 'a.txt' } }] };

async function main() {
  console.log('— the 3:54 PM shape: tools ran, then narration —');
  {
    const m = createMockModel([
      readCall,
      { text: 'Let me continue reading the PlaceNewOrder trait to understand the full flow.' },
      { text: 'Orders are placed via PlaceNewOrder::new_place_order(), called from OrderController.' },
    ], 'narration-after-tools');
    const r = await turn(m);
    ok('a continuation pass ran', m.calls.length === 3, `${m.calls.length} model calls`);
    ok('the nudge told it to close the loop',
      /CLOSE the task|final answer/i.test(JSON.stringify(m.calls[2].messages ?? '')),
      JSON.stringify(m.calls[2].messages ?? '').slice(-160));
    ok('the narration is not what ships', !r.text.startsWith('Let me continue'), r.text.slice(0, 60));
    ok('the real answer ships instead', r.text.includes('new_place_order'), r.text.slice(0, 80));
  }

  console.log('\n— the already-covered quadrants still behave —');
  {
    const m = createMockModel([readCall, { text: '' }, { text: 'Done: read a.txt.' }], 'empty-after-tools');
    const r = await turn(m);
    ok('tools ran + empty reply still nudges', m.calls.length === 3, `${m.calls.length}`);
    ok('and ships the continuation', r.text.includes('Done'), r.text);
  }
  {
    const m = createMockModel([{ text: "I'll read the file and report back." }, { text: 'Read it: hello.' }], 'narration-no-tools');
    const r = await turn(m);
    ok('no tools + narration still nudges', m.calls.length === 2, `${m.calls.length}`);
    ok('and ships the continuation', r.text.includes('hello'), r.text);
  }

  console.log('\n— and a real answer is never second-guessed —');
  {
    const m = createMockModel([
      readCall,
      { text: 'Orders are placed in PlaceNewOrder::new_place_order() at line 545.' },
    ], 'real-answer');
    const r = await turn(m);
    ok('a genuine answer after tools is left alone', m.calls.length === 2, `${m.calls.length} model calls`);
    ok('it ships verbatim', r.text.includes('line 545'), r.text.slice(0, 70));
  }
  {
    // "Let me know if…" must not read as narration: it is a closing courtesy, not a plan.
    const m = createMockModel([
      readCall,
      { text: 'The order flow starts at OrderController::place_order(). Let me know if you want the detail.' },
    ], 'closing-courtesy');
    const r = await turn(m);
    ok('an answer that merely CONTAINS "let me" is not nudged', m.calls.length === 2, `${m.calls.length}`);
    ok('it ships verbatim', r.text.includes('place_order'), r.text.slice(0, 70));
  }
  {
    const m = createMockModel([readCall, { text: 'Let me continue reading the trait.' }], 'ask-mode');
    const r = await turn(m, { mode: 'ask', messages: [{ role: 'user', content: 'how are orders placed?' }] }, runAskStream);
    // 2 calls = the tool step plus the SDK's natural following step. A nudge would be a 3rd.
    ok('ask mode is never nudged', m.calls.length === 2, `${m.calls.length} model calls`);
    ok('its prose answer ships', r.text.includes('Let me continue'), r.text.slice(0, 50));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nLoop closing holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

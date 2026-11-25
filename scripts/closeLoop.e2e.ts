/* A turn that ran tools and came back EMPTY gets one continuation — on wire-level signals only.
 * Guessing "announced instead of acting" from reply text is a regex tower. A non-empty synthesis
 * ships as-is; unfinished todos surface the host's Continue button. Run: npm run test:e2e:close-loop */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockModel';
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
    onAskUser: async () => ({ status: 'answered' as const, answers: ['yes'] }), onError: () => {},
    ...over,
  } as AgentOpts;
}

async function turn(model: ReturnType<typeof createMockModel>, over: Partial<AgentOpts> = {},
  entry = runAgentStream): Promise<AgentResult> {
  __setEngineModelForTests(model);
  try { return await runWithWorkspaceRoot(root, () => entry(opts(over))); }
  finally { __setEngineModelForTests(undefined); }
}

const readCall = { toolCalls: [{ toolName: 'readFile', input: { path: 'a.txt' } }] };

async function main() {
  console.log('— tools ran, non-empty synthesis ships as-is (no prose guessing) —');
  {
    const m = createMockModel([
      readCall,
      { text: 'Let me continue reading the PlaceNewOrder trait to understand the full flow.' },
    ], 'narration-after-tools');
    const r = await turn(m);
    ok('no continuation on non-empty synthesis', m.calls.length === 2, `${m.calls.length} model calls`);
    ok('the synthesis ships verbatim', r.text.includes('Let me continue reading'), r.text.slice(0, 60));
  }

  console.log('\n— the wire-level gaps still nudge —');
  {
    const m = createMockModel([readCall, { text: '' }, { text: 'Done: read a.txt.' }], 'empty-after-tools');
    const r = await turn(m);
    ok('tools ran + empty reply still nudges', m.calls.length === 3, `${m.calls.length}`);
    ok('and ships the continuation', r.text.includes('Done'), r.text);
  }
  {
    const m = createMockModel([{ text: '' }, { text: 'Read it: hello.' }], 'empty-no-tools');
    const r = await turn(m);
    ok('no tools + empty reply still nudges', m.calls.length === 2, `${m.calls.length}`);
    ok('and ships the continuation', r.text.includes('hello'), r.text);
  }

  console.log('\n— non-empty prose after tools is never second-guessed —');
  {
    const m = createMockModel([
      readCall,
      { text: "Now I'll start editing the index.blade.php file first. Let me create the modernized version." },
    ], 'narration-behind-marker');
    const r = await turn(m);
    ok('a "Now I\'ll…" narration is NOT nudged', m.calls.length === 2, `${m.calls.length} model calls`);
    ok('it ships verbatim', r.text.includes("Now I'll start editing"), r.text.slice(0, 70));
  }
  {
    // Kilo/nemotron-3-ultra-550b, same task, same shape, different stem.
    const m = createMockModel([
      readCall,
      { text: 'Now let me rewrite the entire map-related JavaScript section in index.blade.php.' },
    ], 'narration-behind-marker-2');
    const r = await turn(m);
    ok('a "Now let me…" narration is NOT nudged', m.calls.length === 2, `${m.calls.length}`);
    ok('it ships verbatim', r.text.includes('Now let me rewrite'), r.text.slice(0, 70));
  }
  {
    // A real answer that merely opens with a discourse marker is left alone.
    const m = createMockModel([
      readCall,
      { text: 'Now the map uses AdvancedMarkerElement in both files (index.blade.php:401).' },
    ], 'marker-then-real-answer');
    const r = await turn(m);
    ok('a real answer opening with a marker is NOT nudged', m.calls.length === 2, `${m.calls.length}`);
    ok('it ships verbatim', r.text.includes('index.blade.php:401'), r.text.slice(0, 70));
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

  console.log('— a continuation pass that dies on the wire is a provider pause, not a finished turn —');
  {
    // Pass 1 runs a tool and comes back empty (report-gap => one nudge); the nudge pass dies before
    // its first byte. consumeStream() resolves on stream errors, so before 2026-11-24 only a diag
    // line noted it and pass 1's empty reply shipped as a finished turn.
    const m = createMockModel([readCall, { text: '' }, { error: new Error('TierMux: all 6 model candidates failed') }], 'nudge-died');
    const r = await turn(m);
    ok('the nudge pass ran and died', m.calls.length === 3, `${m.calls.length} model calls`);
    ok('the turn pauses and names the provider stop', r.paused === true && r.stopReason === 'provider', JSON.stringify({ paused: r.paused, stop: r.stopReason, finish: r.finishReason }));
    ok('it is not reported as a hard failure', !r.failed && r.errorMessage === undefined, JSON.stringify({ failed: r.failed, errorMessage: r.errorMessage }));
    ok('and no empty reply is shipped as an answer', r.text.trim() === '', JSON.stringify(r.text));
  }

  console.log('— a message the user sends MID-turn reaches the model at the next step boundary (steering) —');
  {
    type Steer = (text: string) => Promise<boolean>;
    const indexOfUser = (w: NonNullable<AgentResult['workMessages']>): number => w.findIndex((x) => x.role === 'user');

    // (a) The real shape: step 1 read a file and the user adds "also read b.txt" while that is being
    // reported. It must not wait for the whole turn (200 steps can be minutes) — it joins the input
    // of step 2, and the transcript keeps it in order, right before the reply it shaped.
    let handle: Steer | undefined;
    let steered: Promise<boolean> | undefined;
    const m = createMockModel([readCall, { text: 'done, with b as well' }], 'steer');
    const r = await turn(m, {
      onSteerReady: (s) => { handle = s; },
      onTool: () => { if (handle && !steered) steered = handle('also read b.txt'); },
    });
    ok('the engine hands the host a way to steer', !!handle, String(handle));
    ok('the running loop accepted the message', (await steered) === true, String(await steered));
    ok('the model saw it at the very next step — not in the step already under way',
      m.calls.length === 2 && JSON.stringify(m.calls[1].messages).includes('also read b.txt') && !JSON.stringify(m.calls[0].messages).includes('also read b.txt'), `${m.calls.length} model calls`);
    const w = r.workMessages ?? [];
    const at = indexOfUser(w);
    ok('it is kept in the transcript once, right before that step\'s reply',
      at === w.length - 2 && w.filter((x) => x.role === 'user').length === 1 && String(w[at]?.content).includes('also read b.txt'), JSON.stringify(w));
    ok('the turn itself ends normally', r.finishReason === 'stop' && r.text.includes('done, with b as well') && !r.paused, JSON.stringify({ finish: r.finishReason, text: r.text, paused: r.paused }));

    // (b) A steer that lands before the first model call even starts is input to that first step,
    // so it belongs in front of it — and still exactly once.
    const m2 = createMockModel([readCall, { text: 'early note seen' }], 'steer-early');
    let early: Promise<boolean> | undefined;
    const r2 = await turn(m2, { onSteerReady: (s) => { early = s('note: keep it short'); } });
    const w2 = r2.workMessages ?? [];
    ok('a steer sent before the first step is that step\'s input',
      (await early) === true && JSON.stringify(m2.calls[0].messages).includes('keep it short')
      && indexOfUser(w2) === 0 && w2.filter((x) => x.role === 'user').length === 1, JSON.stringify(w2));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nLoop closing holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

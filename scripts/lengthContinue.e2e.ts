/* A reply cut off by the output budget (finish 'length') gets exactly ONE mechanical
 * continuation and the shipped answer is BOTH halves. Repro 2026-08-30, Cloudflare
 * deepseek-r1-distill-qwen-32b: cut mid-sentence after 2m24s of think-narration; AI SDK v7 never
 * continues a 'length' step and the act/report-gap nudge fires only on 'stop'. Also locks the
 * one-continuation invariant: a second 'length' must not grow a ladder, and a length-cut nudge
 * pass must not chain into this guard. Run: npm run test:e2e:length-continue */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockClineModel';
import { runAgentStream } from '../src/agent/agent';
import { __setClineEngineModelForTests } from '../src/agent/core/cline/clineEngine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import type { AgentOpts, AgentResult } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-len-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'hello');

function opts(over: Partial<AgentOpts>): AgentOpts {
  return {
    messages: [{ role: 'user', content: 'list the unused pages in the app' }],
    mode: 'agent', effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
    onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    onAskUser: async () => ({ status: 'answered' as const, answers: ['yes'] }), onError: () => {},
    ...over,
  } as AgentOpts;
}

async function turn(model: ReturnType<typeof createMockModel>, over: Partial<AgentOpts> = {},
  entry = runAgentStream): Promise<AgentResult> {
  __setClineEngineModelForTests(model);
  try { return await runWithWorkspaceRoot(root, () => entry(opts(over))); }
  finally { __setClineEngineModelForTests(undefined); }
}

async function main() {
  // SUPERSEDED-IN-PART on the cline branch. The OLD engine's length-cut ladder (one mechanical
  // continuation, halves stitched, no ladder) was engine-owned; Cline's runtime reports a
  // max-tokens cut to the CALLER instead of auto-continuing (recoverFromIncompleteMaxTokensTurn
  // nudges and returns — the host decides). Locked here: a cut turn RETURNS, ships the partial,
  // and does not wedge or fabricate the missing half.
  console.log('— the 2026-08-30 repro shape: length cut mid-sentence —');
  {
    const m = createMockModel([
      { text: 'The unused pages are admin.php and', finish: 'length' },
      { text: ' settings/legacy.php. Nothing else is unreferenced.' },
    ], 'length-cut');
    const r = await turn(m);
    ok('the cut turn returned without a wedge', !!r && typeof r.text === 'string', `text=${JSON.stringify(r.text.slice(0, 40))}`);
    ok('the partial half ships (no fabricated second half)', r.text.includes('admin.php and') && !r.text.includes('legacy.php'), r.text.slice(0, 60));
    console.log(`SKIP  exactly one continuation pass ran   (Cline reports the cut to the caller; auto-continue is host work now)`);
    console.log(`SKIP  the nudge told it to continue, not restart   (old-engine nudge)`);
  }

  console.log('\n— a second length cut must not grow a ladder —');
  {
    console.log(`SKIP  ladder invariant   (no continuation exists to ladder — see above)`);
  }

  console.log(bad === 0 ? '\nALL PASS (with SKIPs noted)' : `\n${bad} FAILED`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

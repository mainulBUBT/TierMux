/* Session findings note — the per-conversation memory of what has ALREADY been located.
 *
 * The property that matters most here is the negative one: a path the model invented must never
 * enter the note. Everything in it is asserted to the model as established fact on every
 * subsequent turn, so one hallucination admitted here would be repeated for the rest of the
 * session. These assertions are the guard on that.
 *
 * Run: npm run test:e2e:session-findings
 */
import { setWorkspaceRoot } from './bench/agentHarness';
import { recordFindings, findingsPrompt, clearFindings } from '../src/agent/sessionFindings';
import { buildSystemPrompt } from '../src/agent/promptBuilder';

setWorkspaceRoot(process.cwd());
const S = 'sess-1';
let fail = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fail++; };

ok('empty session yields no block', findingsPrompt(S) === '');

recordFindings(S, ['src/agent/core/loop.ts'],
  'Handled in src/router/router.ts:718 and also src/totally/made-up.ts which does not exist.');
const p = findingsPrompt(S);
ok('records a real opened file', p.includes('src/agent/core/loop.ts'));
ok('records a real cited path with its line', p.includes('src/router/router.ts:718'));
ok('REFUSES an invented path', !p.includes('made-up'));

recordFindings(S, [], 'see src/agent/core/loop.ts:1039');
ok('bare mention upgraded to path:line', findingsPrompt(S).includes('src/agent/core/loop.ts:1039'));

recordFindings(S, ['../../etc/passwd', '/etc/passwd'], '');
ok('refuses traversal / absolute paths', !findingsPrompt(S).includes('passwd'));

// ── Wiring, not just the module ────────────────────────────────────────────────────────────
// The note is worthless unless it reaches the model. It was previously implemented, fully
// tested, and called from nowhere — every assertion above passed while the feature did
// nothing. These two check the seam into the system prompt instead of the module in isolation.
void (async () => {
  ok('the note reaches buildSystemPrompt', (await buildSystemPrompt('agent', 'coding', S)).includes('src/agent/core/loop.ts'));
  ok('a session with no note adds nothing', !(await buildSystemPrompt('agent', 'coding', 'other-sess')).includes('Already established'));

  recordFindings(undefined, ['src/agent/core/loop.ts'], '');
  clearFindings(S);
  ok('clearFindings empties the note', findingsPrompt(S) === '');
  ok('cleared note is gone from the system prompt too', !(await buildSystemPrompt('agent', 'coding', S)).includes('Already established'));

  console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
  process.exit(fail === 0 ? 0 : 1);
})();

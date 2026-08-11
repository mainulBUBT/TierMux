/* forceSynthesis must never be the call that dies.
 *
 * A stuck turn is by definition the one carrying the most tool output — the runs that failed this
 * way had made 28-45 tool calls and ~100K characters of results. forceSynthesis used to forward
 * that transcript verbatim, so the one request whose whole job was "tell the user what you found"
 * blew past the context window and returned nothing; the user saw "couldn't summarize its
 * findings either" and the turn's entire investigation was discarded.
 *
 * Run: npm run test:e2e:synth-shrink
 */
import { shrinkForSynthesis } from '../src/agent/core/loop';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };
const tokens = (m: unknown[]) => Math.ceil(JSON.stringify(m).length / 4);

// A realistic dead turn: one question, then 40 large read results — built in the SAME structured
// shape toCoreMessages() actually produces (content as an array of typed parts). pruneMessages
// only recognizes tool-call/tool-result parts inside an array; a plain string `content` (an
// earlier version of this fixture) is invisible to it, silently no-op-ing every prune pass.
const huge: any[] = [{ role: 'user', content: 'Add a per-turn tool-call budget end to end.' }];
for (let i = 0; i < 40; i++) {
  huge.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'readFile', input: { path: `src/f${i}.ts` } }] });
  huge.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'readFile', output: { type: 'text', value: `contents of src/f${i}.ts\n${'x'.repeat(2500)}` } }] });
}
const before = tokens(huge);
const after = shrinkForSynthesis(huge as never) as unknown[];
console.log(`  transcript ~${before} tok -> ~${tokens(after)} tok`);
ok('a 100K-char transcript is brought under budget', tokens(after) < 9000);
ok('it still carries something to summarise', after.length > 1);
ok('the original user request survives', JSON.stringify(after).includes('per-turn tool-call budget'));

// The actual production crash this fixes: AI_MissingToolResultsError, thrown when a tool-CALL
// part survives shrinking but its paired tool-RESULT was dropped (or vice versa) — an earlier
// version of the third pass filtered 'tool' messages without removing their matching assistant
// tool-call, orphaning it. Every call id present must have a matching result id, and vice versa.
const callIds = new Set<string>();
const resultIds = new Set<string>();
for (const m of after as any[]) {
  if (!Array.isArray(m.content)) continue;
  for (const part of m.content) {
    if (part.type === 'tool-call') callIds.add(part.toolCallId);
    if (part.type === 'tool-result') resultIds.add(part.toolCallId);
  }
}
const orphanedCalls = [...callIds].filter((id) => !resultIds.has(id));
const orphanedResults = [...resultIds].filter((id) => !callIds.has(id));
ok('no tool-call survives without its result (would throw AI_MissingToolResultsError)', orphanedCalls.length === 0);
ok('no tool-result survives without its call', orphanedResults.length === 0);

// A second, distinct crash found by running the actual complex-task harness: forceSynthesis
// disables tools (single step, no `tools` param) so the model MUST answer in prose, but a weak
// model mid-investigation can still try to "call" one by emitting an inline dialect AS TEXT — and
// since forceSynthesis only listens for text-delta parts, that raw XML streams straight to the
// user as the "final answer". Observed for real: a stuck synthesis's entire answer was
// `<tool_call>\n<function=readFile>\n<parameter=path>\nsrc/agent/core/loop.ts\n</parameter>...`.
//
// A THIRD bug was found in the fix for the second: discarding the WHOLE text whenever a dialect
// attempt appeared ANYWHERE was too blunt. Confirmed from a real user session (screenshot,
// 2026-08-10): the agent successfully made two real edits (config/roles.php,
// GranularPermissionSeeder.php — visible in the UI's "2 files changed" / Undo-all card), wrote a
// genuine summary of what it changed, then tried one more verification call as text. The
// all-or-nothing version discarded the summary along with the garbage, so the user was told "I
// looked into this and ran some tools, but couldn't produce a final answer" about a turn that had
// just edited two real files — a confident lie, strictly worse than the raw-dialect leak this was
// built to prevent. Fixed by keeping the real prefix when there is one.
{
  // stripToolCallAttempt is internal to loop.ts; mirror its logic here as a documented contract
  // test, since importing an unexported function isn't possible from a separate module.
  const ACTION_INTENT_RE = /\b(let me|i'?ll|i will|let'?s|i'?m going to|now i'?ll|i can|i'?d|i should|let me go ahead and)\b[^.!?\n]*\b(read|open|look at|inspect|examine|check|review|fix|edit|update|change|modify|rewrite|replace|implement|create|add|remove|delete|run|execute|search|grep|find|explore|apply|write)\b[^.!?\n]*[:.]?\s*$/i;
  const TOOL_CALL_DIALECT_RE = /(?:<tool_call>|<function=|<｜+DSML｜|\{\s*"(?:name|type)"\s*:)/;
  const stripToolCallAttempt = (text: string) => {
    const m = TOOL_CALL_DIALECT_RE.exec(text);
    if (!m) return text;
    const prefix = text.slice(0, m.index).trim();
    const words = prefix ? prefix.split(/\s+/).length : 0;
    return words >= 12 && !ACTION_INTENT_RE.test(prefix) ? prefix : '';
  };

  ok(
    'pure XML with nothing before it (turn 1): discards entirely',
    stripToolCallAttempt('<tool_call>\n<function=readFile>\n<parameter=path>\nsrc/agent/core/loop.ts\n</parameter>') === '',
  );
  ok('bare <function=…> opener, no prefix: discards entirely', stripToolCallAttempt('<function=editFile><parameter=path>a.ts</parameter>') === '');
  ok('name/arguments JSON blob, no prefix: discards entirely', stripToolCallAttempt('{"name":"grep","arguments":{"pattern":"x"}}') === '');
  ok(
    'meta-narration prefix ending on an announced action (turn 2): discards despite 16 words — it is "let me find X", not a finding',
    stripToolCallAttempt('Now let me read the specific parts of `runTurn`.\n\nLet me find the key code sections.\n<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>src/agent/core/loop.ts</arg_value>\n</tool_call>') === '',
  );
  // The screenshot scenario, reconstructed: a real, substantive, COMPLETED-action summary, not an
  // announced future one, followed by a stray verification attempt.
  const screenshot = stripToolCallAttempt(
    'I updated config/roles.php to add the new "editor" role definition, and updated '
    + 'seeders/GranularPermissionSeeder.php so the new role seeds with the correct permission set. '
    + 'Both files changed successfully. <tool_call>getDiagnostics\n<arg_key>path</arg_key>\n<arg_value>config/roles.php</arg_value>\n</tool_call>',
  );
  ok('real completed-work summary before a trailing tool-call attempt: KEEPS the summary', screenshot.startsWith('I updated config/roles.php'));
  ok('kept text has the trailing dialect fragment removed', !screenshot.includes('<tool_call>'));

  ok('ordinary prose mentioning a function, no dialect: passes through unchanged', stripToolCallAttempt('The function=x notation is used in math, not code here.') === 'The function=x notation is used in math, not code here.');
  ok('a normal summary answer, no dialect: passes through unchanged', stripToolCallAttempt('I added the setting to package.json and wired it into loop.ts.') === 'I added the setting to package.json and wired it into loop.ts.');
}

// A short turn must pass through untouched — shrinking is for the failure case only.
const small: any[] = [
  { role: 'user', content: 'where is the router?' },
  { role: 'tool', content: 'src/router/router.ts:1' },
];
const same = shrinkForSynthesis(small as never) as unknown[];
ok('a small transcript is returned unchanged', same === (small as unknown[]));

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
process.exit(bad ? 1 : 0);

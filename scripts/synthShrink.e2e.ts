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
{
  // looksLikeToolCallAttempt is internal to loop.ts; mirror its regex here as a documented
  // contract test, since importing an unexported function isn't possible from a separate module.
  const looksLikeToolCallAttempt = (text: string) => /(?:<tool_call>|<function=|<｜+DSML｜|\{\s*"(?:name|type)"\s*:)/.test(text);
  ok('detects the exact XML observed in production (turn 1)', looksLikeToolCallAttempt('<tool_call>\n<function=readFile>\n<parameter=path>\nsrc/agent/core/loop.ts\n</parameter>'));
  ok('detects the bare <function=…> opener', looksLikeToolCallAttempt('<function=editFile><parameter=path>a.ts</parameter>'));
  ok('detects a name/arguments JSON blob', looksLikeToolCallAttempt('{"name":"grep","arguments":{"pattern":"x"}}'));
  // Second real capture (2026-08-10): prose narration FIRST, then the dialect mid-answer — the
  // original anchored (`^\s*`) regex missed this because the XML wasn't at position 0.
  ok(
    'detects a tool-call dialect embedded AFTER prose narration (turn 2)',
    looksLikeToolCallAttempt('Now let me read the specific parts of `runTurn`.\n\nLet me find the key code sections.\n<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>src/agent/core/loop.ts</arg_value>\n</tool_call>'),
  );
  ok('does NOT flag ordinary prose mentioning a function', !looksLikeToolCallAttempt('The function=x notation is used in math, not code here.'));
  ok('does NOT flag a normal summary answer', !looksLikeToolCallAttempt('I added the setting to package.json and wired it into loop.ts.'));
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

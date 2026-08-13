/* rescueInlineToolCalls against the Hermes/Qwen `<parameter=…>` dialect.
 *
 * From a real 2026-08-09 agent run: `opencode::nemotron-3-ultra-free` spent 4.5 minutes and 28
 * read calls on a multi-part task, tried to edit exactly once using this dialect, and produced
 * ZERO changes on disk — the raw XML was shown to the user as the final answer. Two bugs caused
 * it: no branch parsed this dialect, and shape 1 (`<function=NAME>{json}`) matched the same
 * opener and grabbed a brace out of the search/replace payload, which suppressed every later
 * shape because they only run when nothing matched.
 *
 * Run: npm run test:e2e:rescue-xml
 */
import { rescueInlineToolCalls } from '../src/agent/toolArgs';

// `listTodos` stands in for any parameterless tool — see the zero-arg case below.
const tools = new Set(['editFile', 'readFile', 'writeFile', 'grep', 'listTodos']);
let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

const real = `<tool_call>
<function=editFile>
<parameter=path>
package.json
</parameter>
<parameter=search>
"tiermux.agent.maxStepsPerTurn": {
          "type": "number",
          "default": 50
        },
</parameter>
<parameter=replace>
"tiermux.agent.maxToolCallsPerTurn": { "default": 40 },
</parameter>
</function>
</tool_call>`;

const r = rescueInlineToolCalls(real, tools);
ok('rescues the real captured XML call', r.detected && r.calls.length === 1 && r.calls[0].name === 'editFile');
const a = JSON.parse(r.calls[0]?.arguments ?? '{}');
ok('path extracted, surrounding newlines trimmed', a.path === 'package.json');
ok('search body verbatim, braces intact', typeof a.search === 'string' && a.search.includes('maxStepsPerTurn') && a.search.includes('{'));
ok('replace body verbatim', typeof a.replace === 'string' && a.replace.includes('maxToolCallsPerTurn'));

// Older shapes must not regress.
const json1 = rescueInlineToolCalls('<function=readFile>{"path":"a.ts"}</function>', tools);
ok('shape 1 (JSON args) still works', json1.detected && JSON.parse(json1.calls[0].arguments).path === 'a.ts');
const blob = rescueInlineToolCalls('{"name":"grep","arguments":{"pattern":"x"}}', tools);
ok('shape 2 (name/arguments blob) still works', blob.detected && JSON.parse(blob.calls[0].arguments).pattern === 'x');
ok('unknown tool name ignored', !rescueInlineToolCalls('<function=nope><parameter=a>1</parameter></function>', tools).detected);
ok('plain prose detects nothing', !rescueInlineToolCalls('I will edit package.json now.', tools).detected);

// ── Dialect shapes that were silently DROPPED before the 2026-08-13 audit fixes ──────────────
// Each of these returned `{detected:false, calls:[]}`: no tool ran, no error was raised, and the
// raw text streamed to chat as the final answer.
const argsAsString = rescueInlineToolCalls('{"name": "readFile", "arguments": "{\\"path\\": \\"src/app.ts\\"}"}', tools);
ok('shape 2 with `arguments` as a JSON STRING (the OpenAI wire format) is rescued',
  argsAsString.detected && JSON.parse(argsAsString.calls[0].arguments).path === 'src/app.ts');

const paramsAsString = rescueInlineToolCalls('{"type":"function","name":"readFile","parameters":"{\\"path\\":\\"a.ts\\"}"}', tools);
ok('shape 3 with `parameters` as a JSON STRING is rescued',
  paramsAsString.detected && JSON.parse(paramsAsString.calls[0].arguments).path === 'a.ts');

const fenced = rescueInlineToolCalls('<function=readFile>\n```json\n{"path":"a.ts"}\n```\n</function>', tools);
ok('shape 1 with a ```json-fenced body is rescued',
  fenced.detected && JSON.parse(fenced.calls[0].arguments).path === 'a.ts');

const zeroArg = rescueInlineToolCalls('<tool_call>\n<function=listTodos>\n</function>\n</tool_call>', tools);
ok('a parameterless tool call is rescued', zeroArg.detected && zeroArg.calls[0].name === 'listTodos');

// Shapes 1 and 6 mixed in ONE reply — weak models switch dialects between calls in a single turn.
// The old `if (calls.length === 0)` guard kept only whichever came first, so the editFile here was
// dropped entirely: zero bytes written, no error surfaced.
const mixed = rescueInlineToolCalls(`<function=readFile>{"path":"a.ts"}</function>
<function=editFile>
<parameter=path>b.ts</parameter>
<parameter=search>if (x) { y(); }</parameter>
<parameter=replace>if (x) { z(); }</parameter>
</function>`, tools);
ok('mixed dialects in one reply: BOTH calls survive',
  mixed.calls.length === 2 && mixed.calls.some((c) => c.name === 'readFile') && mixed.calls.some((c) => c.name === 'editFile'));
const mixedEdit = mixed.calls.find((c) => c.name === 'editFile');
ok('mixed dialects: the editFile payload keeps its braces verbatim',
  !!mixedEdit && JSON.parse(mixedEdit.arguments).search === 'if (x) { y(); }');

// Shapes 1 and 6 now BOTH scan the full text, so guard against the opposite failure: one call
// must never be rescued twice and executed twice.
ok('a plain shape-1 call is not duplicated by shape 6',
  rescueInlineToolCalls('<function=readFile>{"path":"a.ts"}</function>', tools).calls.length === 1);
ok('a plain shape-6 call is not duplicated',
  rescueInlineToolCalls('<function=editFile>\n<parameter=path>b.ts</parameter>\n</function>', tools).calls.length === 1);

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
process.exit(bad ? 1 : 0);

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

const tools = new Set(['editFile', 'readFile', 'writeFile', 'grep']);
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

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
process.exit(bad ? 1 : 0);

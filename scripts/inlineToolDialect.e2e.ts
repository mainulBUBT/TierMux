/* A tool call the model wrote as TEXT still runs. toolArgs.ts parsed these dialects for a long
 * time, but its only call site was the HTTP-ERROR path, so a clean 200 reached no rescue
 * (2026-09-01, xKiro deepseek-v4-pro: `<invoke name="readFile">…` rendered as the answer, nothing
 * ran). Guards in order: the generic decoder (shape 10), the streaming opener holding markup back
 * from the bubble, and adoption of the text call into a real one.
 * Run: npm run test:e2e:inline-tool-dialect */
import { adoptInlineToolCalls, rescueInlineToolCalls } from '../src/agent/toolArgs';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const TOOLS = new Set(['readFile', 'editFile', 'todoWrite', 'listDir', 'grep', 'runCommand']);
const parse = (text: string): string[] => rescueInlineToolCalls(text, TOOLS).calls.map((c) => `${c.name} ${c.arguments}`);
const first = (text: string): string => parse(text)[0] ?? '<none>';

// The XML namespace some Claude-trained models keep on their tool tags. Assembled at runtime so
// this source file never contains the literal marker (it would confuse tooling that scans for it).
const NS = 'antml' + ':';

// ── 1. The exact xKiro deepseek-v4-pro reply, verbatim from the 2026-09-01 session ───────────
const XKIRO = '<invoke name="readFile"> <parameter name="path">src/lib/finderScan.js</parameter> '
  + '<parameter name="offset">301</parameter> <parameter name="limit">220</parameter> </invoke>';
ok('xkiro bare <invoke> parses',
  first(XKIRO) === 'readFile {"path":"src/lib/finderScan.js","offset":301,"limit":220}', first(XKIRO));

// ── 2. Dialects nobody hardcoded — the whole point of the generic shape ──────────────────────
ok('tag IS the tool name', first('<readFile><path>package.json</path></readFile>') === 'readFile {"path":"package.json"}',
  first('<readFile><path>package.json</path></readFile>'));
ok('unknown wrapper word carrying name=""',
  first('<call name="listDir"><parameter name="path">src</parameter></call>') === 'listDir {"path":"src"}',
  first('<call name="listDir"><parameter name="path">src</parameter></call>'));
const nsCall = `<${NS}invoke name="grep"><${NS}parameter name="pattern">TODO</${NS}parameter></${NS}invoke>`;
ok('namespaced invoke', first(nsCall) === 'grep {"pattern":"TODO"}', first(nsCall));
ok('imagined name resolves through the alias table',
  first('<invoke name="read"><parameter name="file">a.ts</parameter></invoke>') === 'readFile {"path":"a.ts"}',
  first('<invoke name="read"><parameter name="file">a.ts</parameter></invoke>'));

// ── 3. Braces and newlines inside an edit payload survive ────────────────────────────────────
const EDIT = '<invoke name="editFile"><parameter name="path">a.ts</parameter><parameter name="search">\n'
  + 'function f() {\n  return 1;\n}\n</parameter><parameter name="replace">\nfunction f() {\n  return 2;\n}\n</parameter></invoke>';
const edited = JSON.parse(first(EDIT).slice('editFile '.length)) as Record<string, string>;
ok('edit search keeps its braces byte for byte', edited.search === 'function f() {\n  return 1;\n}', JSON.stringify(edited.search));
ok('edit replace keeps its braces byte for byte', edited.replace === 'function f() {\n  return 2;\n}', JSON.stringify(edited.replace));

// ── 4. Ordinary markup in an answer is NOT a tool call ───────────────────────────────────────
// The registered-tool-set lookup is the only false-positive guard, so this is the guard's test.
const HTML = 'Here is the page:\n<div class="wrap"><h1>Hi</h1><p>Body</p><search><input name="q"></search></div>';
ok('html answer yields no calls', parse(HTML).length === 0, parse(HTML).join(' | '));

// ── 6. Adoption on an ordinary response. When the Router retired (2026-09-05) this was believed to
// happen one layer down, but openai-compat.ts only rescues Groq's failed_generation body — a 200
// reply's text call shipped as the answer (agentBench, kilo stepfun/step-5, 2026-10-12).
// routerProvider now calls adoptInlineToolCalls on every stream. ─────────────────────────────
const DEFS = [
  { type: 'function' as const, function: { name: 'readFile', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function' as const, function: { name: 'exitPlanMode', parameters: { type: 'object', properties: {
    outcome: { type: 'string' }, title: { type: 'string' }, interpretation: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } },
  } } } },
];
const textOnly = adoptInlineToolCalls('Reading it.\n<function=readFile>{"path":"src/a.ts"}</function>', [], DEFS);
ok('a text-only call is adopted', textOnly?.length === 1 && textOnly[0].name === 'readFile' && JSON.parse(textOnly[0].args).path === 'src/a.ts', JSON.stringify(textOnly));

// The split call from the bench: the native call carried outcome+title, the rest sat in the text.
const SPLIT = '<parameter name="interpretation">Add an optional discount field.</parameter>\n<parameter=steps>\n[{"what":"Parse the third field","files":["src/billing/invoice.js"]}]\n</parameter>\n<parameter name="title">ignored — native wins</parameter>\n<parameter name="nonsense">x</parameter>\n</invoke>';
const split = adoptInlineToolCalls(SPLIT, [{ id: 'c1', name: 'exitPlanMode', args: '{"outcome":"plan","title":"Discounts"}' }], DEFS);
const merged = split ? JSON.parse(split[0].args) : {};
ok('a split call gains the keys its text carried', merged.interpretation === 'Add an optional discount field.' && Array.isArray(merged.steps) && merged.steps[0]?.what === 'Parse the third field', JSON.stringify(merged));
ok('a key the native call already has is kept', merged.title === 'Discounts', merged.title);
ok('a key outside the schema is not invented', !('nonsense' in merged));
ok('the call keeps its id', split?.[0].id === 'c1');
ok('prose with no tool markup changes nothing', adoptInlineToolCalls('Here is the plan: 1. edit a.ts', [], DEFS) === undefined);
ok('a complete native call changes nothing', adoptInlineToolCalls(SPLIT, [{ id: 'c2', name: 'readFile', args: '{"path":"x"}' }], DEFS) === undefined);

console.log(bad === 0 ? '\nAll inline-dialect checks passed.' : `\n${bad} check(s) FAILED.`);
process.exit(bad === 0 ? 0 : 1);

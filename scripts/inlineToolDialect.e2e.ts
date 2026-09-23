/* A tool call the model wrote as TEXT still runs. toolArgs.ts parsed these dialects for a long
 * time, but its only call site was the HTTP-ERROR path, so a clean 200 reached no rescue
 * (2026-09-01, xKiro deepseek-v4-pro: `<invoke name="readFile">…` rendered as the answer, nothing
 * ran). Guards in order: the generic decoder (shape 10), the streaming opener holding markup back
 * from the bubble, and adoption of the text call into a real one.
 * Run: npm run test:e2e:inline-tool-dialect */
import { rescueInlineToolCalls } from '../src/agent/toolArgs';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const TOOLS = new Set(['read_files', 'editor', 'search_codebase', 'run_commands']);
const parse = (text: string): string[] => rescueInlineToolCalls(text, TOOLS).calls.map((c) => `${c.name} ${c.arguments}`);
const first = (text: string): string => parse(text)[0] ?? '<none>';
const call = (text: string): { name: string; args: Record<string, unknown> } => {
  const c = rescueInlineToolCalls(text, TOOLS).calls[0];
  return { name: c?.name ?? '<none>', args: c ? JSON.parse(c.arguments) as Record<string, unknown> : {} };
};

// The XML namespace some Claude-trained models keep on their tool tags. Assembled at runtime so
// this source file never contains the literal marker (it would confuse tooling that scans for it).
const NS = 'antml' + ':';

// ── 1. The exact xKiro deepseek-v4-pro reply, verbatim from the 2026-09-01 session ───────────
// Its imagined `readFile {path, offset, limit}` resolves to Cline's read_files: the path wrapped in
// files[], offset/limit folded into that item's line range.
const XKIRO = '<invoke name="readFile"> <parameter name="path">src/lib/finderScan.js</parameter> '
  + '<parameter name="offset">301</parameter> <parameter name="limit">220</parameter> </invoke>';
{
  const c = call(XKIRO);
  ok('xkiro bare <invoke> parses to read_files',
    c.name === 'read_files' && JSON.stringify(c.args) === '{"files":[{"path":"src/lib/finderScan.js","start_line":301,"end_line":520}]}', first(XKIRO));
}

// ── 2. Dialects nobody hardcoded — the whole point of the generic shape ──────────────────────
ok('tag IS the tool name', first('<read_files><path>package.json</path></read_files>') === 'read_files {"files":[{"path":"package.json"}]}',
  first('<read_files><path>package.json</path></read_files>'));
ok('unknown wrapper word carrying name=""',
  first('<call name="run_commands"><parameter name="command">ls src</parameter></call>') === 'run_commands {"commands":["ls src"]}',
  first('<call name="run_commands"><parameter name="command">ls src</parameter></call>'));
const nsCall = `<${NS}invoke name="grep"><${NS}parameter name="pattern">TODO</${NS}parameter></${NS}invoke>`;
ok('namespaced invoke, imagined grep → search_codebase', first(nsCall) === 'search_codebase {"queries":["TODO"]}', first(nsCall));
ok('imagined name resolves through the alias table',
  first('<invoke name="read"><parameter name="file">a.ts</parameter></invoke>') === 'read_files {"files":[{"path":"a.ts"}]}',
  first('<invoke name="read"><parameter name="file">a.ts</parameter></invoke>'));

// ── 3. Braces and newlines inside an edit payload survive ────────────────────────────────────
const EDIT = '<invoke name="editFile"><parameter name="path">a.ts</parameter><parameter name="search">\n'
  + 'function f() {\n  return 1;\n}\n</parameter><parameter name="replace">\nfunction f() {\n  return 2;\n}\n</parameter></invoke>';
const edited = call(EDIT);
ok('an imagined editFile resolves to editor', edited.name === 'editor', edited.name);
ok('edit old_text keeps its braces byte for byte', edited.args.old_text === 'function f() {\n  return 1;\n}', JSON.stringify(edited.args.old_text));
ok('edit new_text keeps its braces byte for byte', edited.args.new_text === 'function f() {\n  return 2;\n}', JSON.stringify(edited.args.new_text));

// ── 4. Ordinary markup in an answer is NOT a tool call ───────────────────────────────────────
// The registered-tool-set lookup is the only false-positive guard, so this is the guard's test.
const HTML = 'Here is the page:\n<div class="wrap"><h1>Hi</h1><p>Body</p><search><input name="q"></search></div>';
ok('html answer yields no calls', parse(HTML).length === 0, parse(HTML).join(' | '));

// ── 6. End to end — retired with the Router on 2026-09-05: the adoption it tested was a second
// pass over a rescue that already happens one layer down (openai-compat.ts calls
// rescueInlineToolCalls on every provider response). Sections 1-5 pin the helpers that use.

console.log(bad === 0 ? '\nAll inline-dialect checks passed.' : `\n${bad} check(s) FAILED.`);
process.exit(bad === 0 ? 0 : 1);

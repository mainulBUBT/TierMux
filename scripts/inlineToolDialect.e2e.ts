/* A tool call the model wrote as TEXT still runs.
 *
 * A model served without a wired tools API writes its call in whatever markup it was trained on
 * and hands it back as ordinary content on a clean HTTP 200. toolArgs.ts has parsed those
 * dialects for a long time — but its only call site was openai-compat's `failed_generation`
 * handler, the HTTP-ERROR path, so a 200 reached no rescue at all. Captured 2026-09-01, xKiro
 * deepseek-v4-pro: the model emitted `<invoke name="readFile"><parameter name="path">…` as its
 * whole reply, the markup was rendered to the user as the answer, nothing ran, and the turn
 * ended. Two of the three defenses on that path were dead code.
 *
 * Guards, in order: the generic decoder (shape 10) parses a dialect nobody hardcoded; the
 * streaming opener holds such markup back from the chat bubble; and Router.route adopts the text
 * call into a real one so the tool actually executes.
 *
 * Run: npm run test:e2e:inline-tool-dialect
 */
import { rescueInlineToolCalls, findInlineToolOpener } from '../src/agent/toolArgs';
import { Router } from '../src/router/router';
import type { ChatMessage } from '../src/shared/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
ok('html answer is not held from the live stream', findInlineToolOpener(HTML, TOOLS) === -1);
ok('prose alone is not held', findInlineToolOpener('Let me check the scanner first.', TOOLS) === -1);

// ── 5. The streaming hold starts AT the markup, so prose ahead of it still streams ───────────
const MIXED = 'Let me read that file.\n' + XKIRO;
ok('opener found at the markup, not before', findInlineToolOpener(MIXED, TOOLS) === MIXED.indexOf('<invoke'),
  String(findInlineToolOpener(MIXED, TOOLS)));
ok('bare tool-name tag is held too', findInlineToolOpener('<readFile><path>a</path></readFile>', TOOLS) === 0);

// ── 6. End to end: Router.route turns the text into a real tool_call ─────────────────────────
// This is the wiring that was missing. The fixture replays a model whose reply is nothing but
// dialect text; route() must hand back tool_calls, not content.
async function routeAdopts(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-dialect-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ version: 1, steps: [{ taskKind: 'agent', dialect: XKIRO }] }));
  process.env.TIERMUX_FAKE_MODEL = '1';
  process.env.TIERMUX_MOCK_FIXTURE = fixture;

  const router = new Router({} as never, {} as never, {} as never, {} as never);
  const messages: ChatMessage[] = [{ role: 'user', content: 'read the scanner' }];
  const result = await router.route(messages, {
    taskKind: 'agent',
    tools: [...TOOLS].map((name) => ({ type: 'function' as const, function: { name, parameters: { type: 'object', properties: {} } } })),
  } as never);

  const msg = result.response.choices?.[0]?.message;
  ok('route() adopted the text call', msg?.tool_calls?.length === 1, `tool_calls=${msg?.tool_calls?.length ?? 0}`);
  ok('adopted call names the right tool', msg?.tool_calls?.[0]?.function.name === 'readFile', msg?.tool_calls?.[0]?.function.name);
  ok('adopted call carries the arguments',
    JSON.parse(msg?.tool_calls?.[0]?.function.arguments ?? '{}').path === 'src/lib/finderScan.js',
    msg?.tool_calls?.[0]?.function.arguments);
  ok('markup is not also shown as the answer', !msg?.content, JSON.stringify(msg?.content));
  ok('finish_reason says tool_calls', result.response.choices?.[0]?.finish_reason === 'tool_calls',
    result.response.choices?.[0]?.finish_reason);
  fs.rmSync(dir, { recursive: true, force: true });
}

routeAdopts().then(() => {
  console.log(bad === 0 ? '\nAll inline-dialect checks passed.' : `\n${bad} check(s) FAILED.`);
  process.exit(bad === 0 ? 0 : 1);
});

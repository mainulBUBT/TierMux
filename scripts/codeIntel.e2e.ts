/* The language-server tools (outline / findSymbol / references / definition) — driven through an
 * injected command executor, so no real language server is needed. Locks the formatting, the
 * fallback to the regex outline, whole-word symbol location, and that every failure is an
 * `{ error }` or a plain "nothing found" the model can act on. Run: npm run test:e2e:code-intel */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createOutlineTool, createFindSymbolTool, createReferencesTool, createDefinitionTool,
  formatOutline, locateSymbol, type Exec,
} from '../src/agent/core/tools/v3/codeIntel';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { buildV3ToolSet, READ_ONLY_TOOLS } from '../src/agent/core/tools/v3';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-intel-'));
fs.writeFileSync(path.join(root, 'a.ts'), 'export function handleAuth() {\n  return check();\n}\nfunction check() { return handleAuth; }\nconst handleAuthor = 1;\n');
fs.writeFileSync(path.join(root, 'b.ts'), "import { handleAuth } from './a';\nhandleAuth();\n");

type T = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const run = async (t: unknown, args: unknown) => {
  const r = await runWithWorkspaceRoot(root, () => (t as T).execute(args, {}));
  return typeof r === 'string' ? r : `ERROR: ${r.error}`;
};
const range = (a: number, b: number) => ({ start: { line: a, character: 0 }, end: { line: b, character: 0 } });
const uriOf = (f: string) => ({ toString: () => `file://${path.join(root, f)}`, fsPath: path.join(root, f), path: path.join(root, f) });

async function main() {
  console.log('— locateSymbol finds whole words only —');
  const src = fs.readFileSync(path.join(root, 'a.ts'), 'utf8');
  ok('skips the longer identifier handleAuthor', locateSymbol(src, 'handleAuth')?.line === 0);
  ok('honours an explicit line', locateSymbol(src, 'handleAuth', 4)?.line === 3);
  ok('a symbol that is not there is undefined', locateSymbol(src, 'nope') === undefined);
  ok('regex metacharacters in a name are safe', locateSymbol('a.b()', 'a.b') !== undefined);

  console.log('\n— outline: language-server symbols, nested and capped in depth —');
  const tree = [{ name: 'Auth', kind: 4, range: range(0, 20), children: [{ name: 'login', kind: 5, range: range(2, 9), children: [{ name: 'inner', kind: 12, range: range(3, 4), children: [{ name: 'deep', kind: 12, range: range(3, 3) }] }] }] }];
  const lines = formatOutline(tree);
  ok('class then indented method with ranges', lines[0] === 'class Auth  L1-21' && lines[1] === '  method login  L3-10', lines.join(' | '));
  ok('depth is capped at 2 levels below the top', lines.length === 3, lines.join(' | '));
  const withServer: Exec = async (cmd) => (cmd === 'vscode.executeDocumentSymbolProvider' ? tree as never : undefined);
  const o1 = await run(createOutlineTool(withServer), { path: 'a.ts' });
  ok('outline wraps the symbols with the file’s line count', o1.includes('<outline path="a.ts" lines="6">') && o1.includes('class Auth  L1-21'), o1.slice(0, 120));

  console.log('\n— outline falls back to the regex extractor when no server answers —');
  const noServer: Exec = async () => [] as never;
  const o2 = await run(createOutlineTool(noServer), { path: 'a.ts' });
  ok('regex outline names the functions', o2.includes('handleAuth') && o2.includes('regex'), o2.slice(0, 160));
  const o3 = await run(createOutlineTool(noServer), { path: 'missing.ts' });
  ok('a missing file is an error', o3.startsWith('ERROR:') && o3.includes('missing.ts'));

  console.log('\n— findSymbol —');
  const ws: Exec = async () => [
    { name: 'handleAuth', kind: 11, containerName: 'auth', location: { uri: uriOf('a.ts'), range: range(0, 2) } },
    { name: 'handleAuth', kind: 11, location: { uri: uriOf('node_modules/x/index.js'), range: range(4, 4) } },
  ] as never;
  const f1 = await run(createFindSymbolTool(ws), { query: 'handleAuth' });
  ok('formats kind, container and path:line', f1.includes('function handleAuth (in auth)') && f1.includes('a.ts:1'), f1);
  ok('drops node_modules hits', !f1.includes('node_modules'));
  const f2 = await run(createFindSymbolTool(noServer), { query: 'zzz' });
  ok('no hit says so and points at grep', f2.includes('No symbol matching') && f2.includes('grep'));

  console.log('\n— references —');
  let seenArgs: unknown[] = [];
  const refs: Exec = async (cmd, ...args) => {
    seenArgs = [cmd, ...args];
    return [{ uri: uriOf('a.ts'), range: range(3, 3) }, { uri: uriOf('b.ts'), range: range(1, 1) }] as never;
  };
  const r1 = await run(createReferencesTool(refs), { path: 'a.ts', symbol: 'handleAuth' });
  ok('asks the reference provider at the symbol’s position', seenArgs[0] === 'vscode.executeReferenceProvider' && (seenArgs[2] as { line: number }).line === 0, JSON.stringify(seenArgs[2]));
  ok('lists each use with its code', r1.startsWith('2 reference(s)') && r1.includes('b.ts:2  handleAuth();'), r1);
  const r2 = await run(createReferencesTool(noServer), { path: 'a.ts', symbol: 'handleAuth' });
  ok('no references says so and points at grep', r2.includes('No references') && r2.includes('grep'));
  const r3 = await run(createReferencesTool(refs), { path: 'a.ts', symbol: 'ghost' });
  ok('a symbol absent from the file is an error', r3.startsWith('ERROR:') && r3.includes('ghost'));

  console.log('\n— definition (accepts LocationLink shape) —');
  const def: Exec = async () => [{ targetUri: uriOf('a.ts'), targetRange: range(0, 2) }] as never;
  const d1 = await run(createDefinitionTool(def), { path: 'b.ts', symbol: 'handleAuth' });
  // The mock's asRelativePath returns absolute paths; real VS Code returns workspace-relative ones.
  ok('resolves to path:line and the declaration text', d1.endsWith('a.ts:1  export function handleAuth() {'), d1);

  console.log('\n— wiring —');
  for (const mode of ['ask', 'plan', 'agent'] as const) {
    const set = buildV3ToolSet(mode);
    ok(`${mode} mode offers all four`, ['outline', 'findSymbol', 'references', 'definition'].every((n) => n in set));
  }
  ok('all four are read-only (auto-approved, dedupe-cached)', ['outline', 'findSymbol', 'references', 'definition'].every((n) => READ_ONLY_TOOLS.has(n)));
  ok('the phantom tool names are gone from the read-only set', !['getSymbolGraph', 'getDependencyTree', 'recallNotes', 'checkPlan'].some((n) => READ_ONLY_TOOLS.has(n)));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nCode-intel tools hold.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

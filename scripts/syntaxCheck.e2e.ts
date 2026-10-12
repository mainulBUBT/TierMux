/* A write that breaks a file's syntax says so in the SAME tool result — the language's own checker
 * on that one file — so the model fixes it on its next step even with no language server and no
 * project test suite. Silent on success, on unchecked extensions, and when the checker is missing.
 * Run: npm run test:e2e:syntax-check */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEditFileTool } from '../src/agent/core/tools/v3/editFile';
import { createWriteFileTool } from '../src/agent/core/tools/v3/filesystemOps';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { hasOnPath } from '../src/agent/core/tools/workspace/verifyCommand';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d.slice(0, 160).replace(/\n/g, ' ⏎ ')})` : ''}`); if (!c) bad++; };
const MARK = 'Syntax check failed';

// Under $HOME, not /tmp: container-backed php wrappers (lerd) refuse or crawl outside the home dir.
const base = path.join(os.homedir(), '.cache');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'tm-syntax-'));
type Exec = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const editFile = createEditFileTool() as Exec;
const writeFile = createWriteFileTool() as Exec;
const str = (r: string | { error: string }) => (typeof r === 'string' ? r : `ERROR: ${r.error}`);
const edit = (p: string, search: string, replace: string) => runWithWorkspaceRoot(root, async () => str(await editFile.execute({ path: p, search, replace }, {})));
const write = (p: string, content: string) => runWithWorkspaceRoot(root, async () => str(await writeFile.execute({ path: p, content }, {})));

async function main() {
  if (hasOnPath('php')) {
    console.log('— php -l —');
    fs.writeFileSync(path.join(root, 'Cart.php'), '<?php\nfunction total(array $items): float {\n  return array_sum($items);\n}\n');
    const broke = await edit('Cart.php', 'return array_sum($items);', 'return array_sum($items)');
    ok('an edit that breaks PHP syntax reports it', broke.startsWith('Edited') && broke.includes(MARK) && /line \d+/.test(broke), broke);
    const fixed = await edit('Cart.php', 'return array_sum($items)\n', 'return array_sum($items);\n');
    ok('the fixing edit is silent', fixed.startsWith('Edited') && !fixed.includes(MARK), fixed);
    const written = await write('New.php', '<?php\nclass A {\n');
    ok('writeFile of broken PHP reports it', written.startsWith('Wrote') && written.includes(MARK), written);
  } else console.log('SKIP  php not on PATH');

  if (hasOnPath('python3')) {
    console.log('\n— python3 ast.parse (no __pycache__) —');
    const r = await write('m.py', 'def f(:\n    return 1\n');
    ok('broken Python reports file:line', r.includes(MARK) && /m\.py:1:/.test(r), r);
    ok('no bytecode written into the project', !fs.existsSync(path.join(root, '__pycache__')));
    ok('valid Python is silent', !(await write('ok.py', 'def f():\n    return 1\n')).includes(MARK));
  } else console.log('SKIP  python3 not on PATH');

  if (hasOnPath('ruby')) {
    console.log('\n— ruby -c —');
    ok('broken Ruby reports it', (await write('a.rb', 'def f(\n')).includes(MARK));
  }
  if (hasOnPath('bash')) {
    console.log('\n— bash -n —');
    ok('broken shell script reports it', (await write('a.sh', 'if then\n')).includes(MARK));
  }

  console.log('\n— left alone —');
  ok('JS is not parsed here (JSX would be a false error)', !(await write('App.js', 'export const A = () => <div/>;\n')).includes(MARK));
  ok('an unchecked extension is silent', !(await write('notes.txt', 'if then (\n')).includes(MARK));
  ok('a checker that fails for its own reasons is silent', await (async () => {
    const { syntaxNote } = await import('../src/agent/core/tools/workspace/syntaxCheck');
    return (await syntaxNote(path.join(root, 'missing-file.py'))) === '';
  })());
  const PATH = process.env.PATH;
  process.env.PATH = '';
  try {
    ok('a missing checker is silent, not an error', (await write('Gone.php', '<?php\nclass {\n')).startsWith('Wrote'));
  } finally { process.env.PATH = PATH; }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nPer-file syntax check holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

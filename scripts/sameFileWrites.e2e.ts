/* The SDK runs one step's tool calls concurrently (Promise.all). Writes to the same file must still
 * land as if run one after another: no success reported for a change that is not on disk.
 * Run: npm run test:e2e:same-file-writes */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModelMessage } from 'ai';
import { createMockModel } from './mockModel';
import { runAgentStream } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { createEditFileTool } from '../src/agent/core/tools/v3/editFile';
import { createReadFileTool } from '../src/agent/core/tools/v3/readFile';
import { createWriteFileTool, createDeleteFileTool } from '../src/agent/core/tools/v3/filesystemOps';
import { withPathLock } from '../src/agent/core/tools/pathLock';
import type { AgentOpts } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-samefile-'));
const file = (n: string) => path.join(root, n);
const put = (n: string, body: string) => fs.writeFileSync(file(n), body);
const get = (n: string) => (fs.existsSync(file(n)) ? fs.readFileSync(file(n), 'utf8') : null);

type Exec = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const editFile = createEditFileTool() as Exec;
const writeFile = createWriteFileTool() as Exec;
const deleteFile = createDeleteFileTool() as Exec;
const readFile = createReadFileTool() as Exec;
const str = (r: string | { error: string }) => (typeof r === 'string' ? r : `ERROR: ${r.error}`);
const inRoot = <T>(fn: () => Promise<T>) => runWithWorkspaceRoot(root, fn);

async function main() {
  console.log('— engine: two editFile calls on one file in ONE step —');
  {
    put('foo.txt', 'hello world');
    const states: string[] = [];
    const m = createMockModel([
      { toolCalls: [
        { toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'HELLO' } },
        { toolName: 'editFile', input: { path: './foo.txt', search: 'world', replace: 'WORLD' } },
      ] },
      { text: 'done' },
    ], 'same-step');
    __setEngineModelForTests(m);
    try {
      await inRoot(() => runAgentStream({
        messages: [{ role: 'user', content: 'uppercase both words in foo.txt' }],
        mode: 'agent', effort: 'medium', autoApprove: true,
        onChunk: () => {}, onReasoning: () => {}, onModel: () => {}, onFailover: () => {}, onStep: () => {}, onTodos: () => {},
        onTool: (e: unknown) => { const t = e as { name: string; state: string }; if (t.name === 'editFile' && (t.state === 'done' || t.state === 'error')) states.push(t.state); },
        onAskUser: async () => ({ status: 'answered' as const, answers: ['yes'] }), onError: () => {},
      } as AgentOpts));
    } finally { __setEngineModelForTests(undefined); }
    ok('both calls reported success', states.length === 2 && states.every((x) => x === 'done'), states.join(','));
    ok('both edits are on disk', get('foo.txt') === 'HELLO WORLD', JSON.stringify(get('foo.txt')));
  }

  console.log('\n— editFile + writeFile on one file, concurrently —');
  {
    put('w.txt', 'hello world');
    const readArgs = { path: 'w.txt' };
    const readOut = str(await inRoot(() => readFile.execute(readArgs, {})));
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'r1', toolName: 'readFile', input: readArgs }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'r1', toolName: 'readFile', output: { type: 'text', value: readOut } }] },
    ] as ModelMessage[];
    const [e, w] = (await inRoot(() => Promise.all([
      editFile.execute({ path: 'w.txt', search: 'hello', replace: 'HELLO' }, { messages }),
      writeFile.execute({ path: 'w.txt', content: 'rewritten\n' }, { messages }),
    ]))).map(str);
    const editOk = e.startsWith('Edited');
    const writeOk = w.startsWith('Wrote');
    ok('not both reported success (one of them would be lost)', !(editOk && writeOk), `edit=${e.slice(0, 40)} write=${w.slice(0, 60)}`);
    const disk = get('w.txt');
    ok('disk matches what succeeded', writeOk ? disk === 'rewritten\n' : editOk ? disk === 'HELLO world' : disk === 'hello world', JSON.stringify(disk));
  }

  console.log('\n— editFile + deleteFile on one file, concurrently —');
  {
    put('d.txt', 'hello world');
    const [e, d] = (await inRoot(() => Promise.all([
      editFile.execute({ path: 'd.txt', search: 'hello', replace: 'HELLO' }, {}),
      deleteFile.execute({ path: 'd.txt' }, {}),
    ]))).map(str);
    ok('a reported delete leaves no file behind', !d.startsWith('Deleted') || get('d.txt') === null, `edit=${e.slice(0, 40)} delete=${d.slice(0, 40)} disk=${JSON.stringify(get('d.txt'))}`);
  }

  console.log('\n— the lock is per file: others are not held up; a symlinked path is the same file —');
  {
    const { Uri } = require('vscode') as { Uri: { file: (p: string) => import('vscode').Uri } };
    fs.mkdirSync(file('real'));
    fs.symlinkSync(file('real'), file('link'));
    put('real/x.txt', '');
    let release!: () => void;
    const held = withPathLock(Uri.file(file('real/x.txt')), () => new Promise<void>((r) => { release = r; }));
    const order: string[] = [];
    const other = withPathLock(Uri.file(file('other.txt')), async () => { order.push('other'); });
    const viaLink = withPathLock(Uri.file(file('link/x.txt')), async () => { order.push('link'); });
    await other;
    await new Promise((r) => setTimeout(r, 20));
    ok('a different file runs while one is held', order.join() === 'other', order.join());
    release();
    await Promise.all([held, viaLink]);
    ok('the symlinked path waited for the held real path', order.join() === 'other,link', order.join());
    const failing = withPathLock(Uri.file(file('real/x.txt')), async () => { throw new Error('boom'); });
    const after = withPathLock(Uri.file(file('real/x.txt')), async () => 'ran');
    ok('a write that throws reaches its caller and does not block the next', (await failing.catch((e: Error) => e.message)) === 'boom' && (await after) === 'ran');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nSame-file writes are serialized.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

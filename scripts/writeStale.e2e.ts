/* writeFile must not replace an existing file from content the model cannot see. The guard reads
 * the STEP TRANSCRIPT (options.messages, post-prepareStep): a verbatim, complete, still-current
 * readFile block (or the model's own last writeFile) must match the disk. Root-caused 2026-09-21:
 * aging/prune/condense stubbed the read, the model rewrote the file from memory and deleted code.
 * Run: npm run test:e2e:write-stale */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModelMessage } from 'ai';
import { createReadFileTool } from '../src/agent/core/tools/v3/readFile';
import { createWriteFileTool } from '../src/agent/core/tools/v3/filesystemOps';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-write-'));
const file = (n: string) => path.join(root, n);
const put = (n: string, body: string) => fs.writeFileSync(file(n), body);
const get = (n: string) => fs.readFileSync(file(n), 'utf8');

type Exec = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const readFile = createReadFileTool() as Exec;
const writeFile = createWriteFileTool() as Exec;
const str = (r: string | { error: string }) => (typeof r === 'string' ? r : `ERROR: ${r.error}`);
const inRoot = <T>(fn: () => Promise<T>) => runWithWorkspaceRoot(root, fn);

const callMsg = (id: string, toolName: string, input: unknown): ModelMessage =>
  ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] }) as ModelMessage;
const resultMsg = (id: string, toolName: string, value: string): ModelMessage =>
  ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }] }) as ModelMessage;

/** A transcript in which the model really called readFile (the tool's own output, verbatim). */
async function withRead(args: Record<string, unknown>): Promise<ModelMessage[]> {
  const out = str(await inRoot(() => readFile.execute(args, {})));
  return [callMsg('r1', 'readFile', args), resultMsg('r1', 'readFile', out)];
}
const write = (p: string, content: string, messages?: ModelMessage[]) =>
  inRoot(async () => str(await writeFile.execute({ path: p, content }, messages ? { messages } : {})));

async function main() {
  put('small.ts', 'export const keep = 1;\nexport const two = 2;\n');
  put('big.ts', Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n'));
  put('empty.ts', '');

  console.log('— new and empty files need no read —');
  ok('a brand-new file is created', (await write('new.ts', 'x', [])).startsWith('Wrote'));
  ok('an empty existing file can be written', (await write('empty.ts', 'y', [])).startsWith('Wrote'));

  console.log('\n— an unseen existing file is refused —');
  const unseen = await write('small.ts', 'export const oops = 9;\n', []);
  ok('errors, telling the model to readFile', unseen.startsWith('ERROR:') && unseen.includes('readFile'), unseen.slice(0, 90));
  ok('disk is untouched', get('small.ts') === 'export const keep = 1;\nexport const two = 2;\n');

  console.log('\n— a whole, current read unlocks it —');
  const read = await withRead({ path: 'small.ts' });
  ok('write after a full read succeeds', (await write('small.ts', 'export const keep = 2;\n', read)).startsWith('Wrote'));

  console.log('\n— a partial or paged read does NOT unlock it —');
  put('small.ts', 'a\nb\nc\nd\n');
  const partial = await withRead({ path: 'small.ts', offset: 2 });
  ok('a read starting past line 1 is refused', (await write('small.ts', 'z', partial)).startsWith('ERROR:'));
  const paged = await withRead({ path: 'big.ts' });
  const pagedRes = await write('big.ts', 'gone', paged);
  ok('a read cut by the 800-line limit is refused, steering to editFile', pagedRes.startsWith('ERROR:') && pagedRes.includes('editFile') && pagedRes.includes('900 lines'), pagedRes.slice(0, 120));
  ok('big.ts is intact', get('big.ts').split('\n').length === 900);

  console.log('\n— a stubbed read does not count —');
  const stub = [callMsg('r1', 'readFile', { path: 'small.ts' }),
    resultMsg('r1', 'readFile', '[readFile small.ts — 3,000 chars / 4 lines returned in an earlier step; output elided to keep the prompt small. Re-run the tool to see it again.]')];
  ok('an elided read is refused', (await write('small.ts', 'z', stub)).includes('not in view'));

  console.log('\n— a read that went stale is refused —');
  const before = await withRead({ path: 'small.ts' });
  put('small.ts', 'changed on disk\n');
  ok('disk changed since the read → refused, says so', (await write('small.ts', 'z', before)).includes('changed since you read it'));

  console.log('\n— its own last write counts as a view —');
  put('small.ts', 'v1\n');
  const first = [callMsg('w1', 'writeFile', { path: 'small.ts', content: 'v1\n' }), resultMsg('w1', 'writeFile', 'Wrote small.ts.')];
  ok('rewriting what it just wrote succeeds', (await write('small.ts', 'v2\n', first)).startsWith('Wrote'));

  console.log('\n— no transcript (bare tool / sub-agent) → unchanged —');
  put('small.ts', 'q\n');
  ok('without options.messages there is no guard', (await write('small.ts', 'r\n')).startsWith('Wrote'));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nwriteFile staleness guard holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

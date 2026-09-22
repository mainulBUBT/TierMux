/* The model is told which files it changed earlier this session and what they look like on disk
 * NOW — compaction/condense leave it only stubs and paths. Run: npm run test:e2e:session-files */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockClineModel';
import { runAgentStream } from '../src/agent/agent';
import { __setClineEngineModelForTests } from '../src/agent/core/cline/clineEngine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { formatSessionFiles, readSessionFileStates } from '../src/context/sessionFiles';
import type { AgentOpts } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

async function main() {
  console.log('— formatting —');
  ok('nothing touched → no block', formatSessionFiles([]) === undefined);
  const now = 1_000_000_000_000;
  const block = formatSessionFiles([
    { rel: 'src/a.ts', lines: 214, mtime: now - 5 * 60_000 },
    { rel: 'src/gone.ts' },
  ], now)!;
  ok('lists lines and age', block.includes('- src/a.ts — 214 lines, last modified 5 min ago'), block);
  ok('a deleted file says so', block.includes('- src/gone.ts — no longer on disk'));
  ok('warns that earlier reads may be gone', /readFile before you rewrite/.test(block));
  const many = formatSessionFiles(Array.from({ length: 12 }, (_, i) => ({ rel: `f${i}.ts`, lines: 1, mtime: now })), now)!;
  ok('capped at 8 rows with a remainder note', (many.match(/^- f\d+\.ts/gm) ?? []).length === 8 && many.includes('…and 4 more'));

  console.log('\n— reading real disk state —');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sf-'));
  fs.writeFileSync(path.join(root, 'x.ts'), 'a\nb\nc\n');
  const states = await runWithWorkspaceRoot(root, async () => {
    // readSessionFileStates uses the first workspace folder; point the mock at the temp root.
    (require('vscode').workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: require('vscode').Uri.file(root), name: 'w', index: 0 }];
    return readSessionFileStates(['x.ts', 'missing.ts']);
  });
  ok('counts the lines of a file that exists', states[0]?.lines === 4, JSON.stringify(states[0]));
  ok('a missing file is reported gone, not thrown', states[1]?.rel === 'missing.ts' && states[1].lines === undefined);

  console.log('\n— the engine puts the block in the system prompt —');
  const m = createMockModel([{ text: 'done' }], 'sf');
  __setClineEngineModelForTests(m);
  const opts = {
    messages: [{ role: 'user', content: 'what changed?' }], mode: 'agent', effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {}, onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    onAskUser: async () => ({ status: 'answered' as const, answers: ['yes'] }), onError: () => {},
    sessionFiles: async () => '<session_files>\n- src/a.ts — 3 lines\n</session_files>',
  } as AgentOpts;
  try { await runWithWorkspaceRoot(root, () => runAgentStream(opts)); } finally { __setClineEngineModelForTests(undefined); }
  // On the cline branch the block rides in the system prompt (request.systemPrompt).
  const sent = JSON.stringify({ s: m.calls[0]?.systemPrompt, m: m.calls[0]?.messages });
  ok('the block reaches the model', sent.includes('<session_files>') && sent.includes('src/a.ts'), sent.slice(0, 120));

  const m2 = createMockModel([{ text: 'done' }], 'sf2');
  __setClineEngineModelForTests(m2);
  try { await runWithWorkspaceRoot(root, () => runAgentStream({ ...opts, sessionFiles: async () => { throw new Error('disk gone'); } } as AgentOpts)); } finally { __setClineEngineModelForTests(undefined); }
  ok('a failing ledger never fails the turn', m2.calls.length === 1);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nSession files ledger holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

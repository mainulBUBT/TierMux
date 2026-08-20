/* Late re-anchoring (src/agent/core/anchors.ts).
 *
 * Why this exists: PRUNE_TOOL_POLICY evicts read results older than the last 2 messages, so on a
 * long turn the model writes its answer about files it can no longer see. That matches TierMux's
 * measured shape — retrieval 75%, answer 54% (docs/AGENT_QUALITY_2026-08-09.md): the right files
 * ARE found, then lost before the answer. Re-anchoring puts a bounded copy back after each prune.
 *
 * The properties worth pinning are the ones that make it safe to run on every pruned step of every
 * turn: the block is HARD-bounded (it must never be what pushes a turn back over the prune
 * threshold it was triggered by), it is idempotent (re-injecting each step must not stack copies),
 * and it degrades by showing fewer files rather than shrinking every excerpt into uselessness.
 *
 * Deterministic and offline: no router, no model, no vscode, no quota.
 *
 * Run: npm run test:e2e:reanchor
 */
import { AnchorStore, stripAnchorBlock, renderTouchedFiles, ANCHOR_BLOCK_MARKER, MANIFEST_BLOCK_MARKER } from '../src/agent/core/anchors';
import { blankStaleToolResults } from '../src/agent/core/loop';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   (${detail})` : ''}`);
};

const body = (tag: string, n: number): string => `${tag}\n`.repeat(n);

console.log('— Empty / disabled —');
{
  const s = new AnchorStore();
  check('empty store yields no block', s.digest(6000) === '');
  s.record('a.ts', 'export const a = 1;', 1);
  check('budget 0 disables', s.digest(0) === '');
  check('negative budget disables', s.digest(-100) === '');
  check('blank content is not recorded', (() => {
    const t = new AnchorStore();
    t.record('blank.ts', '   \n  ', 1);
    return t.size === 0;
  })());
  check('empty path is not recorded', (() => {
    const t = new AnchorStore();
    t.record('', 'real content', 1);
    return t.size === 0;
  })());
}

console.log('\n— The hard bound: a block can never exceed its budget —');
{
  // The whole safety argument. This fires on a turn that ALREADY crossed the prune threshold, so
  // an over-budget block would re-trigger the very pruning it is compensating for.
  for (const budget of [500, 1000, 4000, 6000, 20000]) {
    const s = new AnchorStore();
    for (let i = 0; i < 12; i++) s.record(`src/file${i}.ts`, body(`content-of-file-${i}`, 5000), i);
    const d = s.digest(budget);
    check(`budget ${budget}: block ≤ budget`, d.length <= budget, `got ${d.length}`);
  }
}

console.log('\n— Freshness: newest read lands nearest the prompt tail —');
{
  const s = new AnchorStore();
  s.record('old.ts', 'OLDEST', 1);
  s.record('mid.ts', 'MIDDLE', 5);
  s.record('new.ts', 'NEWEST', 9);
  const d = s.digest(6000);
  check('all three shown', d.includes('old.ts') && d.includes('mid.ts') && d.includes('new.ts'));
  check('newest is last', d.lastIndexOf('new.ts') > d.lastIndexOf('mid.ts') && d.lastIndexOf('mid.ts') > d.lastIndexOf('old.ts'));
}

console.log('\n— A re-read refreshes rather than duplicates —');
{
  const s = new AnchorStore();
  s.record('a.ts', 'STALE VERSION', 1);
  s.record('b.ts', 'other', 2);
  s.record('a.ts', 'FRESH VERSION', 7);
  const d = s.digest(6000);
  check('one entry per path', s.size === 2, `size=${s.size}`);
  check('newer content wins', d.includes('FRESH VERSION') && !d.includes('STALE VERSION'));
  check('re-read moves it to the tail', d.lastIndexOf('a.ts') > d.lastIndexOf('b.ts'));
}

console.log('\n— Degrade by showing fewer files, not by shrinking all of them —');
{
  const s = new AnchorStore();
  for (let i = 0; i < 8; i++) s.record(`f${i}.ts`, body(`file-${i}`, 2000), i);
  const wide = s.digest(20000);
  const tight = s.digest(1200);
  const filesIn = (d: string): number => (d.match(/\n### /g) ?? []).length;
  check('wide budget caps at MAX_ANCHORED_FILES', filesIn(wide) === 4, `got ${filesIn(wide)}`);
  check('tight budget shows fewer files', filesIn(tight) < filesIn(wide), `${filesIn(tight)} vs ${filesIn(wide)}`);
  check('tight budget still shows at least one', filesIn(tight) >= 1);
  check('tight block still within budget', tight.length <= 1200, `got ${tight.length}`);
}

console.log('\n— Small content is shown whole, not padded or truncated —');
{
  const s = new AnchorStore();
  s.record('tiny.ts', 'export const x = 1;', 1);
  const d = s.digest(6000);
  check('short file kept verbatim', d.includes('export const x = 1;'));
  check('short file not marked truncated', !d.includes('[truncated]'));
}

console.log('\n— Idempotence: re-injecting every pruned step must not stack copies —');
{
  const s = new AnchorStore();
  s.record('a.ts', 'content A', 1);
  const digest = s.digest(6000);
  type Msg = { role: string; content: unknown };
  let msgs: Msg[] = [
    { role: 'user', content: 'original request' },
    { role: 'assistant', content: 'working on it' },
  ];
  // Ten pruned steps in a row — the realistic shape once a turn is over the threshold.
  for (let i = 0; i < 10; i++) {
    msgs = [...stripAnchorBlock(msgs), { role: 'user', content: digest }];
  }
  const blocks = msgs.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(ANCHOR_BLOCK_MARKER));
  check('exactly one block after 10 injections', blocks.length === 1, `got ${blocks.length}`);
  check('message count stays flat', msgs.length === 3, `got ${msgs.length}`);
  check('the real conversation survives', msgs[0].content === 'original request' && msgs[1].content === 'working on it');
}

console.log('\n— stripAnchorBlock touches nothing else —');
{
  type Msg = { role: string; content: unknown };
  const msgs: Msg[] = [
    { role: 'user', content: 'real user message' },
    { role: 'assistant', content: 'reply' },
    { role: 'tool', content: [{ type: 'tool-result' }] },
    { role: 'user', content: `${ANCHOR_BLOCK_MARKER}\n### a.ts\nbody` },
  ];
  const out = stripAnchorBlock(msgs);
  check('only the block is removed', out.length === 3);
  check('non-string content is safe', out.some((m) => m.role === 'tool'));
  check('a user message merely MENTIONING the marker is kept', (() => {
    const tricky: Msg[] = [{ role: 'user', content: `please explain ${ANCHOR_BLOCK_MARKER} to me` }];
    return stripAnchorBlock(tricky).length === 1; // startsWith, not includes
  })());
  check('the manifest block is stripped too', (() => {
    const msgs2: Msg[] = [
      { role: 'user', content: 'real' },
      { role: 'user', content: `${MANIFEST_BLOCK_MARKER}\n- a.ts — read` },
    ];
    return stripAnchorBlock(msgs2).length === 1;
  })());
}

console.log('\n— Pinned working set: edited files outrank merely-read ones —');
{
  // Aider never prunes the files under active edit. Within our fixed 4-slot budget, that means an
  // edited file must not be pushed out by later reads of unrelated files.
  const s = new AnchorStore();
  s.record('read1.ts', body('read1', 40), 1);
  s.pin('edited.ts', body('EDITED', 40), 2);
  for (let i = 0; i < 6; i++) s.record(`later${i}.ts`, body(`later${i}`, 40), 10 + i);
  const d = s.digest(20_000);
  check('the edited file survives 6 later reads', d.includes('edited.ts'));
  check('the oldest unpinned read is dropped instead', !d.includes('read1.ts'));
  check('freshest reads still fill the remaining slots', d.includes('later5.ts'));
  check('a re-read does not clear an existing pin', (() => {
    const t = new AnchorStore();
    t.pin('p.ts', 'pinned body', 1);
    t.record('p.ts', 'later plain read', 2);
    for (let i = 0; i < 6; i++) t.record(`x${i}.ts`, body(`x${i}`, 40), 10 + i);
    return t.digest(20_000).includes('p.ts');
  })());
  check('pin refreshes content to the post-edit text', (() => {
    const t = new AnchorStore();
    t.record('f.ts', 'BEFORE the edit', 1);
    t.pin('f.ts', 'AFTER the edit', 2);
    const out = t.digest(20_000);
    return out.includes('AFTER the edit') && !out.includes('BEFORE the edit');
  })());
  check('blank pin content is ignored', (() => {
    const t = new AnchorStore();
    t.pin('empty.ts', '   ', 1);
    return t.size === 0;
  })());
}

console.log('\n— Blanking keeps the call record that eviction destroys —');
{
  const toolMsg = (id: string, name: string, value: string) => ({
    role: 'tool' as const,
    content: [{ type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'text', value } }],
  });
  const callMsg = (id: string, name: string, path: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: { path } }],
  });
  const msgs = [
    { role: 'user' as const, content: 'do the thing' },
    callMsg('c1', 'readFile', 'src/big.ts'),
    toolMsg('c1', 'readFile', body('huge file line', 500)),
    callMsg('c2', 'editFile', 'src/big.ts'),
    toolMsg('c2', 'editFile', 'Edited src/big.ts.'),
    { role: 'assistant' as const, content: 'done' },
    { role: 'user' as const, content: 'now the next one' },
  ] as never[];
  const { messages: out, blanked } = blankStaleToolResults(msgs);
  const flat = JSON.stringify(out);
  check('a stale read payload is blanked', blanked === 1, `blanked=${blanked}`);
  check('the huge body is gone', !flat.includes('huge file line'));
  check('the call record survives', flat.includes('"toolName":"readFile"') && flat.includes('src/big.ts'));
  check('the placeholder names what was run', flat.includes('readFile(src/big.ts)'));
  check('message count is unchanged (nothing orphaned)', out.length === msgs.length);
  check('the small mutating result is untouched', flat.includes('Edited src/big.ts.'));
  check('blanking is idempotent', blankStaleToolResults(out as never[]).blanked === 0);
  check('the last two messages are never blanked', (() => {
    const recent = [
      { role: 'user' as const, content: 'x' },
      callMsg('c9', 'readFile', 'src/recent.ts'),
      toolMsg('c9', 'readFile', body('recent content', 500)),
    ] as never[];
    return blankStaleToolResults(recent).blanked === 0;
  })());
}

console.log('\n— Touched-files manifest: the floor beneath re-anchoring —');
{
  const changed = new Map<string, 'created' | 'modified' | 'deleted'>([
    ['src/a.ts', 'modified'],
    ['src/new.ts', 'created'],
  ]);
  const out = renderTouchedFiles(['src/a.ts', 'src/read-only.ts'], changed);
  check('empty in, empty out', renderTouchedFiles([], new Map()) === '');
  check('starts with its marker so it can be stripped', out.startsWith(MANIFEST_BLOCK_MARKER));
  check('names a changed file with its status', out.includes('src/new.ts — created'));
  check('names a read-only file', out.includes('src/read-only.ts — read'));
  check('a file both read and edited appears once, as edited', (() => {
    const hits = out.split('\n').filter((l) => l.includes('src/a.ts'));
    return hits.length === 1 && hits[0].includes('modified');
  })());
  check('survives past the content-digest 4-file cap', (() => {
    const many = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    const m = renderTouchedFiles(many, new Map());
    return many.every((p) => m.includes(p));
  })());
  check('caps a runaway list and says how many were omitted', (() => {
    const huge = Array.from({ length: 60 }, (_, i) => `src/g${i}.ts`);
    const m = renderTouchedFiles(huge, new Map());
    return m.includes('and 20 more');
  })());
}

/* ── The seam ──────────────────────────────────────────────────────────────────────────────────
 *
 * Everything above tests anchors.ts in isolation, which is exactly the shape that burned this repo
 * before: docs/AGENT_QUALITY_2026-08-09.md records a findings test that was "fully green while the
 * feature was called from nowhere". So this section drives the REAL runTurn with a fake Router and
 * asserts on the messages that actually reached the model — if the prepareStep wiring is deleted,
 * the unit tests above still pass and these do not.
 */
async function seam(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require('path') as typeof import('path');
  const { runTurn } = await import('../src/agent/core/loop');
  const { setGates } = await import('../src/agent/core/tools/gates');
  const { CommandGate } = await import('../src/edits/commandGate');
  const { EditGate } = await import('../src/edits/applyEdit');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tiermux-reanchor-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];
  setGates(new EditGate(() => false) as never, new CommandGate(() => 'always', () => 5000, () => []) as never);

  // Big enough that one read blows past the prune threshold set below — the whole point is to
  // reach the state where the real tool result has been evicted.
  const target = 'big.ts';
  fs.writeFileSync(nodePath.join(root, target), `// UNIQUE_ANCHOR_TOKEN\n${'export const filler = 1;\n'.repeat(400)}`);

  const run = async (reanchorChars: number): Promise<string[][]> => {
    (globalThis as never as Record<string, unknown>).__tiermuxTestConfig = {
      mixturePipeline: 'off',   // keep the planner from consuming route() calls
      pruneAtTokens: 400,       // force pruning after the first read
      reanchorChars,
      verifyCommand: 'off',
    };
    const seen: string[][] = [];
    let calls = 0;
    const baseResponse = (o: Record<string, unknown>) => ({
      id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...o } }],
    });
    const fakeRouter = {
      async route(messages: Array<{ role: string; content: unknown }>) {
        seen.push(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
        calls++;
        // Three reads, then answer — enough steps for pruning to evict the earliest result.
        if (calls <= 3) {
          return {
            platform: 'custom' as const,
            model: 'fake',
            response: baseResponse({ tool_calls: [{ id: `c${calls}`, type: 'function' as const, function: { name: 'readFile', arguments: JSON.stringify({ path: target }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'done' }) };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    };
    await runTurn(fakeRouter as never, {
      messages: [{ role: 'user', content: 'explain big.ts' }],
      mode: 'agent', effort: 'medium',
      onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
      onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    } as never);
    return seen;
  };

  console.log('\n— Seam: the block reaches the model on a real pruned turn —');
  const withAnchors = await run(6000);
  const anchored = withAnchors.filter((msgs) => msgs.some((c) => c.includes(ANCHOR_BLOCK_MARKER)));
  check('at least one model call received the block', anchored.length > 0, `${anchored.length}/${withAnchors.length} calls`);
  check('the block names the file that was read', anchored.some((msgs) => msgs.some((c) => c.includes(ANCHOR_BLOCK_MARKER) && c.includes(target))));
  check('the block carries real file content, not just the path',
    anchored.some((msgs) => msgs.some((c) => c.includes(ANCHOR_BLOCK_MARKER) && c.includes('UNIQUE_ANCHOR_TOKEN'))));
  check('never more than one block in a single call',
    withAnchors.every((msgs) => msgs.filter((c) => c.includes(ANCHOR_BLOCK_MARKER)).length <= 1));

  console.log('\n— Seam: reanchorChars=0 disables it completely —');
  const without = await run(0);
  check('no block anywhere when disabled', without.every((msgs) => msgs.every((c) => !c.includes(ANCHOR_BLOCK_MARKER))));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void seam();

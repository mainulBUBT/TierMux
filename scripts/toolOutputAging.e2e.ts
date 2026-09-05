/* Tool-output aging — the budget-independent sibling of compactIfNeeded.
 *
 * compactIfNeeded only fires at 80% of the model's window, so a big-window model carries
 * EVERY tool result verbatim through every remaining step: one readFile returns up to 30k
 * chars, an agent turn runs 15–25 round trips, and each one re-prefills the whole history
 * (free gateways don't prompt-cache). ageToolOutputs elides all but the most recent tool
 * message's text outputs into instructive stubs — the same move OpenCode/Kilo make, which
 * is why the same "slow" models feel fast there.
 *
 * Regressions this locks down:
 *   1. The most recent tool message stays verbatim; older fat ones are stubbed.
 *   2. Stubs are instructive (tool + input named, re-run hint) — never a dead reference.
 *   3. Short outputs and error payloads stay untouched (no churn, recovery path intact).
 *   4. Idempotent across steps: stubbing an already-stubbed transcript changes nothing,
 *      matching prepareStep's sticky-override semantics.
 *   5. User/assistant text messages are never touched.
 *
 * Run: npm run test:e2e:tool-output-aging
 */
import type { ModelMessage } from 'ai';
import { ageToolOutputs } from '../src/agent/core/compact';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

// FIXTURE SHAPE IS THE POINT: the SDK's ToolResultPart carries ONLY toolCallId/toolName/
// output — the arguments live on the ASSISTANT message's tool-call part. Fixtures that also
// put `input` on the result part are why the "stub names the path" assertion passed while
// production stubs shipped pathless for a day. Never re-add it here.
const result = (id: string, value: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'readFile', output: { type: 'text', value } }],
} as unknown as ModelMessage);

const call = (id: string, input: Record<string, unknown> = { path: `src/f${id}.ts` }): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'readFile', input }],
} as unknown as ModelMessage);

// ── 1+2: the RECENT WINDOW stays verbatim, older fat output is stubbed, stub is instructive ──
{
  const messages: ModelMessage[] = [
    { role: 'user', content: 'explore' },
    call('a1'), result('a1', 'x'.repeat(30_000)),
    call('a2'), result('a2', 'y'.repeat(28_000)),
    call('a3'), result('a3', 'z'.repeat(27_000)),
    call('a4'), result('a4', 'w'.repeat(26_000)),
    { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
  ] as unknown as ModelMessage[];
  const r = ageToolOutputs(messages);
  const out = r.messages!;
  ok('stubbed chars counted', r.stubbedChars === 30_000, `${r.stubbedChars}`);
  const first = (out[2] as any).content[0];
  ok('older fat output elided', first.output.value.includes('elided') && first.output.value.length < 400, `${first.output.value.length} chars`);
  ok('stub names tool + input', first.output.value.includes('readFile src/fa1.ts'));
  ok('stub carries re-run hint', first.output.value.includes('Re-run the tool'));
  ok('the three most recent tool messages stay verbatim',
    (out[4] as any).content[0].output.value === 'y'.repeat(28_000)
    && (out[6] as any).content[0].output.value === 'z'.repeat(27_000)
    && (out[8] as any).content[0].output.value === 'w'.repeat(26_000));
  ok('user + assistant text untouched', (out[0] as any).content === 'explore' && (out[9] as any).content[0].text === 'thinking');
  ok('no stub when nothing to age (single tool step)', ageToolOutputs([call('z'), result('z', 'x'.repeat(30_000))]).stubbedChars === 0);
  ok('no stub while the window is not yet full (two tool steps)',
    ageToolOutputs([call('p'), result('p', 'x'.repeat(30_000)), call('q'), result('q', 'y'.repeat(30_000))]).stubbedChars === 0);
}

// ── 3: short + error outputs untouched ──
{
  const messages: ModelMessage[] = [
    call('s1', { path: 'small.ts' }),
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 's1', toolName: 'readFile', output: { type: 'text', value: 'tiny' } },
      { type: 'tool-result', toolCallId: 's2', toolName: 'readFile', output: { type: 'json', value: { error: 'EACCES' } } },
    ] },
  ] as unknown as ModelMessage[];
  const r = ageToolOutputs(messages);
  ok('short output kept', r.stubbedChars === 0 && r.messages === undefined);
  ok('error payload kept', ((r.messages ?? messages)[1] as any).content[1].output.value.error === 'EACCES');
}

// ── 4: idempotent — re-aging an aged transcript is a no-op ──
{
  const messages: ModelMessage[] = [
    call('a1'), result('a1', 'x'.repeat(30_000)),
    call('a2'), result('a2', 'y'.repeat(28_000)),
    call('a3'), result('a3', 'z'.repeat(27_000)),
    call('a4'), result('a4', 'w'.repeat(26_000)),
  ];
  const once = ageToolOutputs(messages);
  const twice = ageToolOutputs(once.messages!);
  ok('idempotent on second pass', twice.stubbedChars === 0 && twice.messages === undefined);
  ok('aged transcript keeps structure', (once.messages!.length) === messages.length && (once.messages![3] as any).content[0].output.value === 'y'.repeat(28_000));
}

// ── 6: json outputs are error payloads (every v3 tool returns `string | {error}`) and are
//       never aged, however fat ──
{
  const messages: ModelMessage[] = [
    call('j1'), { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'j1', toolName: 'runCommand', output: { type: 'json', value: { error: 'x'.repeat(30_000) } } }] },
    call('j2'), result('j2', 'y'.repeat(28_000)),
    call('j3'), result('j3', 'z'.repeat(27_000)),
    call('j4'), result('j4', 'w'.repeat(26_000)),
  ] as unknown as ModelMessage[];
  const r = ageToolOutputs(messages);
  ok('fat error payload never aged', r.stubbedChars === 0 && r.messages === undefined);
}

// ── 7: the stub's path comes from the ASSISTANT tool-call part, the only place it lives ──
{
  const messages: ModelMessage[] = [
    call('p1', { path: 'src/deep/target.ts' }), result('p1', 'x'.repeat(30_000)),
    call('p2', { pattern: 'TODO' }), result('p2', 'y'.repeat(28_000)),
    call('p3'), result('p3', 'z'.repeat(27_000)),
    call('p4'), result('p4', 'w'.repeat(26_000)),
  ] as unknown as ModelMessage[];
  const stub = (ageToolOutputs(messages).messages![1] as any).content[0].output.value as string;
  ok('stub names the path with no input on the result part', stub.includes('readFile src/deep/target.ts'), stub.slice(0, 80));
}

// ── 8: read → read → edit. THE reason the window is 3 and not 1 (2026-09-05) ──
// With a one-message window, file A's content was already a stub by the time the model wrote
// the edit for it — while editFile.search has to match A byte-for-byte. Aging was manufacturing
// the exact failure editMatch.ts then had to diagnose.
{
  const fileA = 'export function a() {\n' + '  // body\n'.repeat(3000) + '}\n';
  const messages: ModelMessage[] = [
    { role: 'user', content: 'update a.ts using b.ts as a reference' },
    call('rA', { path: 'src/a.ts' }), result('rA', fileA),
    call('rB', { path: 'src/b.ts' }), result('rB', 'y'.repeat(28_000)),
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'e1', toolName: 'editFile', input: { path: 'src/a.ts', search: 'export function a() {', replace: 'export function a(x: number) {' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'e1', toolName: 'editFile', output: { type: 'text', value: 'Edited src/a.ts.' } }] },
  ] as unknown as ModelMessage[];
  const r = ageToolOutputs(messages);
  ok('read → read → edit keeps the FIRST read verbatim', r.stubbedChars === 0 && r.messages === undefined,
    `stubbed=${r.stubbedChars}`);
}

// ── 5: no tool messages at all → no-op ──
{
  const r = ageToolOutputs([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] as ModelMessage[]);
  ok('pure chat untouched', r.stubbedChars === 0 && r.messages === undefined);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURES`);
process.exit(bad === 0 ? 0 : 1);

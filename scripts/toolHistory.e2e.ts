/* No tool_call may be left orphaned in the work transcript.
 *
 * From a 2026-08-13 audit: `workMessages` was rebuilt from `step.toolCalls` + `step.toolResults`.
 * In ai@7 a tool call that THREW is reported as a `tool-error` part on `step.content` and never
 * lands in `step.toolResults` (`TypedToolError` is a separate type from `TypedToolResult`). So a
 * failing call left an assistant `tool_calls` entry with no matching `role:'tool'` result —
 * an orphan, which `sanitizeCoreMessages` then deleted wholesale on every later turn (the call
 * AND its error, since there was nothing to pair). The model therefore had no record that the
 * call was attempted or why it failed, and on "try again" reissued the identical failing call —
 * e.g. an `editFile` whose `search` text didn't match, retried verbatim.
 *
 * Orphans are also a hard provider error (AI_MissingToolResultsError), the invariant
 * synth-shrink.e2e.ts guards from the other direction.
 *
 * This exercises the same reconstruction shape loop.ts uses, over a step whose calls settle three
 * different ways: normal result, thrown error, and neither (askQuestions / denied approval).
 *
 * Run: npm run test:e2e:tool-history
 */
import type { ChatMessage } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

/** Mirrors the workMessages reconstruction in loop.ts (steps → assistant tool_calls + tool results). */
function buildWorkMessages(steps: Array<Record<string, any>>): ChatMessage[] {
  const workMessages: ChatMessage[] = [];
  for (const step of steps) {
    const calls: any[] = step.toolCalls ?? [];
    if (calls.length === 0) continue;
    workMessages.push({
      role: 'assistant',
      content: step.text || null,
      tool_calls: calls.map((tc) => ({ id: tc.toolCallId, type: 'function' as const, function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) } })),
    });
    const settled = new Set<string>();
    for (const tr of step.toolResults ?? []) {
      workMessages.push({ role: 'tool', content: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? ''), tool_call_id: tr.toolCallId });
      settled.add(tr.toolCallId);
    }
    for (const part of (step.content ?? []) as Array<{ type?: string; toolCallId?: string; error?: unknown }>) {
      if (part?.type !== 'tool-error' || !part.toolCallId || settled.has(part.toolCallId)) continue;
      const msg = part.error instanceof Error ? part.error.message : String(part.error ?? 'unknown error');
      workMessages.push({ role: 'tool', content: `Tool call failed: ${msg}`, tool_call_id: part.toolCallId });
      settled.add(part.toolCallId);
    }
    for (const tc of calls) {
      if (settled.has(tc.toolCallId)) continue;
      workMessages.push({
        role: 'tool',
        content: tc.toolName === 'askQuestions' ? 'Clarification requested.' : 'No result was recorded for this tool call.',
        tool_call_id: tc.toolCallId,
      });
      settled.add(tc.toolCallId);
    }
  }
  return workMessages;
}

// One step, three calls settling three different ways.
const msgs = buildWorkMessages([{
  text: 'Working on it.',
  toolCalls: [
    { toolCallId: 'ok1', toolName: 'readFile', input: { path: 'a.ts' } },
    { toolCallId: 'err1', toolName: 'editFile', input: { path: 'a.ts', search: 'nope' } },
    { toolCallId: 'q1', toolName: 'askQuestions', input: { questions: [] } },
  ],
  toolResults: [{ toolCallId: 'ok1', output: 'file contents' }],
  content: [{ type: 'tool-error', toolCallId: 'err1', error: new Error('Search text not found in file.') }],
}]);

const resultIds = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
const callIds = msgs.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.id));

ok('every tool_call has a matching tool result (no orphans)', callIds.every((id) => resultIds.has(id)));
ok('the successful call keeps its real output', msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'ok1' && String(m.content).includes('file contents')));
ok('the FAILED call is recorded (was silently dropped)', resultIds.has('err1'));
ok('the failure explains WHY, so a retry can avoid repeating it',
  msgs.some((m) => m.tool_call_id === 'err1' && String(m.content).includes('Search text not found')));
ok('askQuestions still gets its short placeholder',
  msgs.some((m) => m.tool_call_id === 'q1' && String(m.content) === 'Clarification requested.'));

// A call that settles neither way (e.g. denied by the approval policy) must still be paired.
const denied = buildWorkMessages([{
  toolCalls: [{ toolCallId: 'd1', toolName: 'writeFile', input: { path: 'x' } }],
  toolResults: [],
  content: [],
}]);
ok('a call with neither result nor error is still paired', denied.some((m) => m.role === 'tool' && m.tool_call_id === 'd1'));

// Results must never be duplicated — a doubled tool_call_id is rejected by OpenAI-compat endpoints.
const ids = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
ok('no tool_call_id is emitted twice', new Set(ids).size === ids.length);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

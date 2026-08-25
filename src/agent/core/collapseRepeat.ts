

import type { ChatMessage } from '../../shared/types';

// Pure transcript bookkeeping — no vscode, no tools, no router. Kept in its own module (not
// core/loop.ts) so lightweight consumers (condense.ts summarizes a persisted history) can use
// it without pulling the whole execution core's dependency graph into their bundle.

/** One step record's identity for {@link collapseRepeatedSteps}: the ordered (tool name,
 *  arguments) pairs of its assistant tool_calls. Call ids are excluded on purpose — the same
 *  calls issued again (new ids, same everything else) must produce the same signature. */
function stepRecordSignature(m: ChatMessage): string | undefined {
  if (m.role !== 'assistant' || !m.tool_calls?.length) return undefined;
  return m.tool_calls.map((tc) => `${tc.function.name}\u0000${tc.function.arguments}`).join('\u0001');
}

/** Collapse runs of 3+ consecutive identical step records (same tool calls, same order, same
 *  arguments, nothing different in between) into first + one-line marker + last. The observed
 *  failure (2026-08-25): a degenerate model loop persisted ~50 byte-identical grep round-trips
 *  into session history, which starved the next turn's fitting window (the original task was
 *  evicted; the model answered a search term the user never sent) and blanked the compaction
 *  summarizer. Keeping the first AND last repeat preserves "what was called" and "what it
 *  finally returned" (runCommand output can legitimately change between identical runs); only
 *  the redundant middle goes. Structurally safe: whole records (assistant tool-call message +
 *  its tool results) are dropped or kept together, so a call can never be orphaned from its
 *  result — the invariant sanitizeCoreMessages enforces stays intact. */
export function collapseRepeatedSteps(messages: ChatMessage[]): ChatMessage[] {
  interface StepRecord { sig: string; start: number; end: number }
  const records: StepRecord[] = [];
  for (let i = 0; i < messages.length; i++) {
    const sig = stepRecordSignature(messages[i]);
    if (sig === undefined) continue;
    // Only the tool messages that actually belong to THIS record's calls (id match) — a stray
    // result from another step (flushStreamWork appends placeholders at the end) must not be
    // swallowed into a group it could then be dropped with.
    const callIds = new Set(messages[i].tool_calls!.map((tc) => tc.id));
    let end = i;
    while (end + 1 < messages.length) {
      const next = messages[end + 1];
      if (next.role !== 'tool' || !callIds.has(next.tool_call_id ?? '')) break;
      end++;
    }
    records.push({ sig, start: i, end });
    i = end;
  }

  const out: ChatMessage[] = [];
  let copyFrom = 0; // next un-copied index in `messages`
  for (let r = 0; r < records.length; ) {
    let runEnd = r;
    while (runEnd + 1 < records.length
      && records[runEnd + 1].sig === records[r].sig
      && records[runEnd + 1].start === records[runEnd].end + 1) runEnd++;
    const runLen = runEnd - r + 1;
    const first = records[r];
    const last = records[runEnd];
    if (runLen < 3) {
      while (copyFrom < last.end + 1) out.push(messages[copyFrom++]); // verbatim
    } else {
      while (copyFrom < first.end + 1) out.push(messages[copyFrom++]); // first repeat verbatim
      out.push({
        role: 'assistant',
        content: `[The tool call(s) above were repeated ${runLen - 2} more time(s) with identical arguments; those results are omitted — the final repeat's result follows.]`,
      });
      copyFrom = last.start; // skip the middle repeats
      while (copyFrom < last.end + 1) out.push(messages[copyFrom++]); // last repeat verbatim
    }
    r = runEnd + 1;
  }
  while (copyFrom < messages.length) out.push(messages[copyFrom++]);
  return out;
}

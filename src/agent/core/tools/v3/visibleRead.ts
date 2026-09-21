// What the model can SEE of a file right now, derived from the transcript the SDK hands a tool
// (`options.messages` = the step's messages AFTER prepareStep aged/pruned them). writeFile uses it
// to refuse a full overwrite from a file the model has no verbatim, current copy of.
// Mechanical only: it compares text, it never judges the incoming content.

import type { ModelMessage } from 'ai';

export type VisibleState =
  | { kind: 'match' }
  | { kind: 'stale' }
  | { kind: 'unseen' };

interface Call { toolName: string; input: Record<string, unknown> }

function callsById(messages: ModelMessage[]): Map<string, Call> {
  const byId = new Map<string, Call>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
        byId.set(part.toolCallId, { toolName: String(part.toolName), input: (part.input ?? {}) as Record<string, unknown> });
      }
    }
  }
  return byId;
}

function outputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && (output as { type?: unknown }).type === 'text'
    && typeof (output as { value?: unknown }).value === 'string') return (output as { value: string }).value;
  return undefined;
}

const FILE_BLOCK = /<file path="([^"]*)">\n([\s\S]*?)\n<\/file>(\n…\[showing lines)?/g;

/** Verbatim file texts the model can see: every COMPLETE readFile block (line 1 to EOF, no paging
 *  marker) whose path resolves to `same`, plus content it wrote itself via a successful writeFile.
 *  A stubbed or pruned result contributes nothing — that is the point. */
function visibleTexts(messages: ModelMessage[], same: (p: string) => boolean): string[] {
  const calls = callsById(messages);
  const texts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool-result') continue;
      const text = outputText(part.output);
      if (text == null) continue;
      const call = calls.get(String(part.toolCallId));
      if (call?.toolName === 'writeFile' && text.startsWith('Wrote ')
        && typeof call.input.path === 'string' && typeof call.input.content === 'string' && same(call.input.path)) {
        texts.push(call.input.content);
        continue;
      }
      if (call?.toolName !== 'readFile') continue;
      for (const block of text.matchAll(FILE_BLOCK)) {
        if (block[3] || !same(block[1])) continue;
        const lines = block[2].split('\n');
        if (!/^\s*1\t/.test(lines[0])) continue;
        texts.push(lines.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n'));
      }
    }
  }
  return texts;
}

/** Does the transcript hold a verbatim copy of `disk` for the file `same` identifies?
 *  match → yes; stale → it holds copies, but none equals the disk now; unseen → none at all. */
export function visibleFileState(messages: ModelMessage[], disk: string, same: (p: string) => boolean): VisibleState {
  const texts = visibleTexts(messages, same);
  if (texts.some((t) => t === disk)) return { kind: 'match' };
  return { kind: texts.length ? 'stale' : 'unseen' };
}

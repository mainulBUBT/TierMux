

import type { ChatMessage } from '../shared/types';
import { estimateMessagesTokens } from './budget';
import { routeOnce, utilityModelPreference } from './core/routeOnce';
import { SUMMARY_SYSTEM, HANDOFF_SYSTEM } from './prompts';
import { capToolOutput } from './core/tools/capOutput';
import { fitMessages, inputBudget } from './budget';
import { resolveExecutionProfile } from './executionProfile';
import { peekTopModel } from '../router/picker';

import { diagLog } from '../util/diag';

/** Recent messages kept verbatim. 10, not 6: a tool-heavy turn spends several messages on its
 *  own round-trips, so 6 could cover one exchange. Cheap, since surviving tool results are
 *  re-capped to TAIL_TOOL_RESULT_CAP. */
const KEEP_TAIL = 10;
/** Re-cap for a tool result surviving in the kept tail: by compaction time the model has acted
 *  on it, and a 30k result kept verbatim would dwarf the summary. */
const TAIL_TOOL_RESULT_CAP = 1500;
/** Caps applied to the prefix BEFORE it is summarized. The summarizer needs what was asked,
 *  decided and changed — not the raw grep/read output the model already acted on, which was
 *  ~95% of a tool-heavy prefix and is what overflowed the summarizer's window (a 50-step turn
 *  sent ~400k tokens to a 32k-window utility model; the provider kept the tail, so the summary
 *  lost the original goal). */
const SUMMARY_TOOL_RESULT_CAP = 400;
const SUMMARY_TOOL_ARGS_CAP = 300;
/** Output budget for the summary itself. */
const SUMMARY_MAX_TOKENS = 2048;
/** A kept tail larger than this (after re-capping) is folded into the summary instead, leaving
 *  only the last user message and the closing reply verbatim: a 50-step turn's tail was ~100
 *  messages of tool stubs — 26k tokens that said nothing the model's own closing reply and the
 *  summary's Done/Next steps do not say better, and the next turn paid for them every step. */
const TAIL_MAX_TOKENS = 8_000;
/** Cap on a tool result as it is PERSISTED into session history after a turn. Anything above
 *  AGE_MIN_CHARS (2,000) is stubbed by tool-output aging before any later step sees it, so a
 *  30k grep result in history was 28k chars nobody could ever read again — only estimate,
 *  persist and summarize. Same value on purpose. */
const PERSIST_TOOL_RESULT_CAP = 2_000;

/** Minimum history length before condensing is worth an LLM call. Sessions with several
 *  tool-heavy turns balloon fast (large grep/read results), so compact a little sooner than the
 *  raw message count suggests — but not so soon that short chats pay for a needless summary. */
const MIN_PREFIX = 6;

/** The one section of SUMMARY_SYSTEM that is enforced in code rather than trusted to the model.
 *  Must match the heading in prompts.ts exactly. */
const FILES_HEADING = '## Files & symbols touched';
/** Prefix of the message condenseHistory emits, so a LATER condensation can find the previous
 *  summary in its own prefix and merge that summary's file list forward (see mergeFilesForward). */
const SUMMARY_PREFIX = 'Summary of the earlier conversation:';
/** Ceiling on paths carried in the enforced section. A repo-wide sweep could otherwise turn the
 *  summary — the thing that exists to be SMALL — into a file listing. */
const MAX_SUMMARY_PATHS = 60;

/** Tool calls whose arguments name a specific file (persisted ChatMessage shape, JSON-string
 *  arguments). */
const PATH_ARG_TOOLS = new Set(['readFile', 'writeFile', 'editFile', 'deleteFile']);

/** The `path`-ish argument of a persisted tool call. Arguments are a JSON string per the OpenAI
 *  shape, and a weak model sometimes double-encodes it — hence the second parse attempt. */
function pathFromArguments(argsJson: string): string | undefined {
  let v: unknown;
  try { v = JSON.parse(argsJson); } catch { return undefined; }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  if (!v || typeof v !== 'object') return undefined;
  const p = (v as Record<string, unknown>).path ?? (v as Record<string, unknown>).file;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/** The section of SUMMARY_SYSTEM that records what the user rejected. Its entries are the one
 *  thing worth keeping ACROSS sessions — see userMemory.appendLearned. */
const CORRECTIONS_HEADING = '## Corrections & rejected approaches';

/** Entries under `heading` in a summary — [] when absent or "(none)". */
export function parseSummarySection(summary: string, heading: string): string[] {
  const lines = summary.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(heading));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('## ')) break;
    const entry = line.trim().replace(/^[-*]\s*/, '').trim();
    if (!entry || entry === '(none)') continue;
    out.push(entry);
  }
  return out;
}

/** Read the entries listed under FILES_HEADING in a summary. Returns [] when the section is
 *  absent or explicitly empty. Entries keep whatever symbol annotation the model wrote after the
 *  path — that annotation is the part a summarizer adds value on. */
function parseFilesSection(summary: string): string[] {
  return parseSummarySection(summary, FILES_HEADING);
}

/** The leading path token of a Files-section entry, used to dedupe "src/a.ts — the thing" against
 *  a bare "src/a.ts" so merging forward can't accumulate near-duplicates of the same file. */
function pathKeyOf(entry: string): string {
  return entry.split(/[\s—–:(]/)[0].replace(/[`,]/g, '').trim() || entry;
}

/** Every file path this stretch touched, plus every path the PREVIOUS summary recorded — the
 *  merge-forward that keeps a file touched before the last compaction from being dropped. */
export function collectTouchedPaths(prefix: ChatMessage[]): string[] {
  const seen = new Map<string, string>(); // pathKey → best entry text
  const add = (entry: string): void => {
    const key = pathKeyOf(entry);
    if (!key) return;
    // A richer entry (path + symbols, from a summarizer) beats a bare path from a tool call.
    const existing = seen.get(key);
    if (!existing || entry.length > existing.length) seen.set(key, entry);
  };
  for (const m of prefix) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX)) {
      for (const entry of parseFilesSection(m.content)) add(entry);
    }
    for (const call of m.tool_calls ?? []) {
      if (!PATH_ARG_TOOLS.has(call.function.name)) continue;
      const p = pathFromArguments(call.function.arguments);
      if (p) add(p);
    }
  }
  return [...seen.values()];
}

/** Guarantee the summary's file list in code, not by asking: union what the model wrote with
 *  what the conversation provably touched, and write the section back whether or not the model
 *  produced one. Weak summarizers drop the mandated section under load. */
export function ensureFilesSection(summary: string, knownPaths: string[]): string {
  const written = parseFilesSection(summary);
  const merged = new Map<string, string>();
  // Model-written entries first: they carry the symbol annotations, and preserving their order
  // keeps the summarizer's own sense of what mattered most.
  for (const e of [...written, ...knownPaths]) {
    const key = pathKeyOf(e);
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing || e.length > existing.length) merged.set(key, e);
  }
  if (merged.size === 0) return summary;
  const all = [...merged.values()];
  const shown = all.slice(0, MAX_SUMMARY_PATHS);
  const omitted = all.length - shown.length;
  const body = shown.map((e) => `- ${e}`).join('\n') + (omitted > 0 ? `\n- (…and ${omitted} more)` : '');

  const lines = summary.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(FILES_HEADING));
  if (start === -1) return `${summary.trimEnd()}\n\n${FILES_HEADING}\n${body}\n`;
  // Replace the existing section body, leaving every other section untouched.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) { end = i; break; }
  }
  return [...lines.slice(0, start), FILES_HEADING, body, '', ...lines.slice(end)].join('\n').trimEnd() + '\n';
}

/** True when the conversation is long enough that condensing is worthwhile. */
export function shouldCondense(history: ChatMessage[]): boolean {
  return history.length >= KEEP_TAIL + MIN_PREFIX;
}

/** Condense `history` into `[summary, ...recentTail]`, splitting on a 'user' boundary so the
 *  tail never starts mid-tool-round. Returns null when there's too little to summarize or the
 *  summarizer produced nothing. `previousModel` is named in the summary for a different model
 *  picking up the compacted history. */

/** One utility completion with ONE retry on a BLANK reply. routeOnce already fails over on
 *  errors; an HTTP-200 with whitespace-only content is not an error, and that case is how
 *  "Compaction produced no summary" reached the user. Retries with a different model. */
async function completeOnce(
  request: ChatMessage[],
  label: string,
): Promise<{ text: string; key: string } | null> {
  const first = await routeOnce(request, {
    taskKind: 'chat', temperature: 0.2, maxTokens: SUMMARY_MAX_TOKENS, model: utilityModelPreference(), label,
  });
  if (first.text.trim()) return { text: first.text.trim(), key: first.key };
  diagLog(`${label}.retry`, `empty output from ${first.key} — retrying with a different model`);
  const second = await routeOnce(request, {
    taskKind: 'chat', temperature: 0.2, maxTokens: SUMMARY_MAX_TOKENS, exclude: [first.key], label,
  });
  return second.text.trim() ? { text: second.text.trim(), key: second.key } : { text: '', key: second.key };
}

export async function condenseHistory(
  history: ChatMessage[],
  previousModel?: string,
): Promise<{ messages: ChatMessage[]; summary: string; corrections: string[] } | null> {
  if (!shouldCondense(history)) return null;

  // Walk BACKWARD to the nearest user boundary. Scanning forward ran off the end on tool-heavy
  // sessions (the last KEEP_TAIL messages all assistant/tool), so the largest contexts could
  // never compact. Backward only ever makes the tail LONGER than requested.
  let tailStart = history.length - KEEP_TAIL;
  while (tailStart > 0 && history[tailStart].role !== 'user') tailStart--;
  // No user turn at all before the tail (degenerate) — nothing safe to split on.
  if (tailStart < 0 || history[tailStart].role !== 'user') return null;
  let prefix = history.slice(0, tailStart);
  let tail = recapTailToolResults(history.slice(tailStart));
  // Oversized tail (one tool-heavy turn): fold it into the summary too. The tail becomes the
  // turn's own user message plus its closing reply, so the next turn still opens on the exact
  // ask and the model's own account of what it did. Also the only way a session that STARTS
  // with a mega-turn (tailStart 0, empty prefix) ever compacts.
  if (estimateMessagesTokens(tail) > TAIL_MAX_TOKENS) {
    const last = history[history.length - 1];
    const closing = last.role === 'assistant' && !last.tool_calls?.length
      && typeof last.content === 'string' && last.content.trim() ? [last] : [];
    prefix = history.slice(0, history.length - closing.length);
    tail = [history[tailStart], ...closing];
    diagLog('condense.fold', `tail of ${history.length - tailStart} message(s) folded into the summary; kept the user message${closing.length ? ' + closing reply' : ''}`);
  }
  if (prefix.length < 3) return null;

  const instruction = { role: 'user' as const, content: 'Summarize the conversation above so it can continue with minimal context. Keep file names, decisions, and unresolved next steps. If it opens with an earlier summary, carry its Goal, Corrections and Next steps forward unless later messages supersede them.' };
  // Shrink, then fit to the summarizer's own window: fitMessages keeps the system prompt, the
  // FIRST user message (the goal) and the instruction, and fills newest-first between them.
  const budget = inputBudget(resolveExecutionProfile(await peekTopModel('chat')).contextWindow, SUMMARY_MAX_TOKENS);
  const summaryRequest = fitMessages([
    { role: 'system' as const, content: SUMMARY_SYSTEM },
    ...shrinkForSummary(prefix),
    instruction,
  ], budget).messages;

  const attempt = await completeOnce(summaryRequest, 'condense');
  let summary = attempt?.text ?? '';
  if (!summary) {
    // Two models both came back blank — often a provider silently truncating an over-budget
    // prompt. Try once more with only the newer half of the prefix.
    diagLog('condense.retry', `empty summary again from ${attempt?.key ?? 'auto'} — retrying with a shorter prefix`);
    const shortRequest = fitMessages([
      { role: 'system' as const, content: SUMMARY_SYSTEM },
      ...shrinkForSummary(prefix),
      instruction,
    ], Math.floor(budget / 2)).messages;
    summary = (await completeOnce(shortRequest, 'condense'))?.text ?? '';
  }
  if (!summary) {
    diagLog('condense.fail', 'empty summary after two models and a shortened prefix — giving up');
    return null;
  }

  // Deterministic enforcement of the one section that must not be lost — see ensureFilesSection.
  // Runs on every path out of the retry ladder above, including the shortened-prefix fallback,
  // where the model literally could not have seen the older half of the conversation: the paths
  // still come from `prefix`, so a file drops out of the summary only if it was never touched.
  const knownPaths = collectTouchedPaths(prefix);
  const enforced = ensureFilesSection(summary, knownPaths);
  if (enforced !== summary) {
    diagLog('condense.files', `enforced ${FILES_HEADING} (${knownPaths.length} path(s) from history merged in)`);
    summary = enforced;
  }

  const carry = previousModel ? `\n\n(Continued from a previous model: ${previousModel}.)` : '';
  const summaryMsg: ChatMessage = { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}${carry}` };
  return { messages: [summaryMsg, ...tail], summary, corrections: parseSummarySection(summary, CORRECTIONS_HEADING) };
}

/** Minimum history length before a handoff note is worth an LLM call — a session that's barely
 *  started has nothing to hand off. */
const MIN_HANDOFF_HISTORY = 2;

/** A standalone handoff note for the whole history — read-only, never mutates the session.
 *  Returns null when there's too little conversation or the summarizer produced nothing. */
export async function generateHandoff(history: ChatMessage[]): Promise<string | null> {
  if (history.length < MIN_HANDOFF_HISTORY) return null;

  const request = [
    { role: 'system' as const, content: HANDOFF_SYSTEM },
    ...history,
    { role: 'user' as const, content: 'Write the handoff note for the conversation above.' },
  ];

  return (await completeOnce(request, 'handoff'))?.text || null;
}

/** A finished turn's work messages as they should enter session history: tool results capped
 *  at PERSIST_TOOL_RESULT_CAP. Call↔result pairing and every other message are untouched. */
export function capForHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= PERSIST_TOOL_RESULT_CAP) return m;
    return { ...m, content: capToolOutput(m.content, PERSIST_TOOL_RESULT_CAP, 'Re-run the tool if you need the full output again.') };
  });
}

/** The prefix as the summarizer should see it: tool results and tool-call arguments capped,
 *  user and assistant text intact. Paths survive in the arguments' head; the file list is
 *  enforced from the UNshrunk prefix anyway (collectTouchedPaths). */
function shrinkForSummary(prefix: ChatMessage[]): ChatMessage[] {
  return prefix.map((m) => {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > SUMMARY_TOOL_RESULT_CAP) {
      return { ...m, content: capToolOutput(m.content, SUMMARY_TOOL_RESULT_CAP) };
    }
    if (m.role === 'assistant' && m.tool_calls?.some((c) => c.function.arguments.length > SUMMARY_TOOL_ARGS_CAP)) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((c) => c.function.arguments.length > SUMMARY_TOOL_ARGS_CAP
          ? { ...c, function: { ...c.function, arguments: c.function.arguments.slice(0, SUMMARY_TOOL_ARGS_CAP) + '…' } }
          : c),
      };
    }
    return m;
  });
}

/** Re-cap `tool`-role content in the kept tail to TAIL_TOOL_RESULT_CAP. Only `content` is
 *  touched, so the call↔result pairing stays intact. */
function recapTailToolResults(tail: ChatMessage[]): ChatMessage[] {
  return tail.map((m) => {
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= TAIL_TOOL_RESULT_CAP) return m;
    return { ...m, content: capToolOutput(m.content, TAIL_TOOL_RESULT_CAP, 'Re-run the tool if you need the full output again.') };
  });
}

import { splitReasoning } from '../agent/content';

/** Reduce a model's reply to a clean short title, or ''. Reasoning models leak chain-of-thought
 *  (sometimes with no <think> tags), so anything that reads like an explanation is rejected. */
export function sanitizeTitle(raw: string): string {
  let s = (splitReasoning(raw || '').content || '')
    .split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  s = s.replace(/^["'`]+|["'`.]+$/g, '').trim();
  if (!s) return '';
  const words = s.split(/\s+/).filter(Boolean);

  const cot = /\b(the user|user'?s message|this is|let me|we need|i'?ll|i will|i should|first,?|okay,?|because|according|greeting|not a|the message|so the title|title for)\b/i;
  if (words.length > 8 || s.length > 64 || cot.test(s)) return '';
  return s;
}

const CODE_LINE = /^\s*(?:```|curl\b|git\b|npm\b|yarn\b|pnpm\b|docker\b|kubectl\b|ssh\b|python[23]?\b|node\b|go\b|cargo\b|make\b|sudo\b|\$\s|#\s|--\S|https?:\/\/|[{[])/i;

/** First line of prose in a message — skips code fences, shell commands, URLs and JSON
 *  so a pasted curl/log/snippet doesn't become the title basis. Falls back to the raw
 *  text if every line looks code-like (nothing prose to pick from). */
function firstProseLine(text: string): string {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const prose = lines.find((l) => !CODE_LINE.test(l) && l.split(/\s+/).length >= 2);
  return prose ?? lines[0] ?? '';
}

/** A plain readable title from a message when the LLM title is unusable (first ~6 words
 *  of the first prose line, so a pasted command/log doesn't swamp the placeholder). */
export function deriveTitleFrom(text: string): string {
  const line = firstProseLine(text);
  const s = line.trim().replace(/\s+/g, ' ').replace(/[?.!,;:]+$/, '');
  if (!s) return 'New chat';
  const words = s.split(' ').slice(0, 6).join(' ').slice(0, 60);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

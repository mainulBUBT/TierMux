import type { TodoItem } from '../shared/types';
import { splitReasoning } from '../agent/content';

/**
 * Reduce a model's reply to a clean short title, or '' if it doesn't look like one.
 * Reasoning models often leak chain-of-thought (sometimes truncated mid-thought with
 * no <think> tags) — reject anything that reads like an explanation rather than a title.
 */
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

/** Turn an approved plan's text into an initial all-pending todo list (list lines only). */
export function planStepsToTodos(steps: string): TodoItem[] {
  return (steps || '')
    .split('\n')
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/)) // numbered or bulleted list items
    .filter((mm): mm is RegExpMatchArray => !!mm)
    .map((mm) => ({ content: mm[1].replace(/\*\*/g, '').trim(), status: 'pending' as const }))
    .filter((t) => t.content.length > 0)
    .slice(0, 20);
}

const PLAN_EDIT_VERB = /^(add|create|implement|build|writ|fix|refactor|rename|move|delete|remove|updat|chang|modif|edit|replac|wir|integrat|convert|migrat|install|configur|extract|split|merg|append|insert|expos|export|hook|connect|introduc|switch|drop|bump|upgrad|enabl|disabl|set ?up|scaffold|register|inject|guard|validat)\w*\b/i;
const PLAN_PATHISH = /[\w./-]+\.[a-z]{1,6}\b|\b[\w-]+\/[\w-]+/;

/**
 * True when plan text reads like ACTIONABLE changes (imperative steps and/or file references)
 * rather than a descriptive answer. Gates the "Approve & Run" UI: a reply to "give me 6 changes"
 * or "how does this work?" is a discussion answer (no run button), not a plan to execute.
 */
export function looksLikeActionablePlan(text: string): boolean {
  const steps = planStepsToTodos(text).map((t) => t.content);
  if (steps.length === 0) return false; // no list items → prose answer, never a runnable plan
  const actionable = steps.filter((s) => PLAN_EDIT_VERB.test(s) || PLAN_PATHISH.test(s)).length;
  return actionable >= Math.ceil(steps.length / 2);
}

import type { TodoItem } from '../shared/types';
import { splitReasoning } from '../agent/content';

/** A short relative-time label ("just now", "5m ago", "2h ago", "3d ago"). */
export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

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
  // Tell-tale signs the model explained instead of titling (or got cut off mid-reasoning).
  const cot = /\b(the user|user'?s message|this is|let me|we need|i'?ll|i will|i should|first,?|okay,?|because|according|greeting|not a|the message|so the title|title for)\b/i;
  if (words.length > 8 || s.length > 64 || cot.test(s)) return '';
  return s;
}

/** A plain readable title from a message when the LLM title is unusable (first ~6 words). */
export function deriveTitleFrom(text: string): string {
  const s = (text || '').trim().replace(/\s+/g, ' ').replace(/[?.!,;:]+$/, '');
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

// A list step that reads like a CHANGE: starts with an imperative edit-verb, or names a file/path.
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

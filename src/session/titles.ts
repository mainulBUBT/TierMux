import type { TodoItem } from '../shared/types';
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

const PLAN_EDIT_VERB = /^(add|create|implement|build|writ|fix|refactor|rename|move|delete|remove|updat|chang|modif|edit|replac|wir|integrat|convert|migrat|install|configur|extract|split|merg|append|insert|expos|export|hook|connect|introduc|switch|drop|bump|upgrad|enabl|disabl|set ?up|scaffold|register|inject|guard|validat|sync|audit|document|correct|review|ensur|verify|test|apply|enforce|generat|wir)\w*\b/i;
const PLAN_PATHISH = /[\w./-]+\.[a-z]{1,6}\b|\b[\w-]+\/[\w-]+/;

/** An approved plan's text as an all-pending todo list. Four step shapes: list items, markdown
 *  headings, bold-only lines, and bare imperative PARAGRAPH lines naming a file — the shape free
 *  models produce most, which used to parse to zero steps so the plan card never opened. */
export function planStepsToTodos(steps: string): TodoItem[] {
  return (steps || '')
    .split('\n')
    .map((line) => {
      // Numbered or bulleted list item.
      let m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
      if (m) return m[1];
      // Markdown heading: "## Step", "### Step".
      m = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
      if (m) return m[1];
      // Bold-only heading line: "**Step**".
      m = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
      if (m) return m[1];
      // Imperative paragraph line with no list marker but a clear edit verb AND a file/path
      // reference — the "Create/Add/Update <file>" plan format weak models emit as prose.
      const trimmed = line.trim();
      if (trimmed && PLAN_EDIT_VERB.test(trimmed) && PLAN_PATHISH.test(trimmed)) return trimmed;
      return null;
    })
    .filter((c): c is string => c !== null)
    .map((c) => ({ content: c.replace(/\*\*/g, '').trim(), status: 'pending' as const }))
    .filter((t) => t.content.length > 0)
    .slice(0, 20);
}

/** True when plan text reads like ACTIONABLE changes rather than a descriptive answer — gates
 *  "Approve & Run". Counts edit-like steps plus imperative lines naming a file; true at ≥2, since
 *  a real plan touches more than one thing and prose Q&A rarely leads with edit verbs. */
export function looksLikeActionablePlan(text: string): boolean {
  const t = text || '';
  const actionables = new Set<string>();
  for (const step of planStepsToTodos(t).map((s) => s.content)) {
    if (PLAN_EDIT_VERB.test(step) || PLAN_PATHISH.test(step)) actionables.add(step);
  }
  // Also scan raw lines for imperative+path paragraphs (covers the case where planStepsToTodos'
  // 20-item cap or formatting kept them out, and keeps this independent of the todo builder).
  for (const line of t.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && PLAN_EDIT_VERB.test(trimmed) && PLAN_PATHISH.test(trimmed)) actionables.add(trimmed);
  }
  return actionables.size >= 2;
}

// Conversation Memory — deterministic compression of the last 3-5 turns.
//
// Problem: follow-up messages like "now add API endpoint" have no context.
//   The model greps from scratch, re-discovers the same files, wastes turns.
//
// Solution: extract GOAL + FILES + STATUS from recent history and inject them
//   as a ~50-100 token block BEFORE retrieval. The model immediately knows
//   "this is a continuation of delivery-slots work on StoreController.php".
//
// Zero AI. Zero latency. Deterministic extraction only.

import type { ChatMessage } from '../shared/types';
import type { ExecutionTracker } from './executionMemory';

// ---- Config ----
const TURNS_TO_SCAN = 3;        // last N user+assistant pairs = 6 messages
const MAX_GOAL_CHARS = 100;     // truncate previous user messages to this
const MAX_FILES = 6;            // max files to list

// ---- File path extraction ----
// Matches relative source file paths mentioned in any message content.
const FILE_RE = /\b([\w./\\-]+\.(?:php|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|kt|rb|swift|vue|html|css|json|yaml|yml|env|md|sql|sh))\b/g;

function extractFilePaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(FILE_RE)) {
    const p = m[1];
    // Skip obvious non-paths (single token, node_modules, lock files)
    if (p.length < 4 || p.includes('node_modules') || p.endsWith('.lock')) continue;
    found.add(p);
  }
  return [...found];
}

// ---- Status extraction ----
// Keyword scan of the last assistant message to surface a brief status signal.
const DONE_RE = /\b(complet|finish|done|creat|add|implement|migrat|success|now\s+you\s+can)\b/i;
const ERROR_RE = /\b(error|fail|cannot|can't|couldn't|undefined|exception|crash|broke)\b/i;

function extractStatus(assistantText: string): string {
  const lower = assistantText.toLowerCase();
  if (ERROR_RE.test(lower)) {
    // Extract the first error-ish sentence (max 80 chars)
    const sentence = assistantText.split(/[.!?\n]/)[0].trim().slice(0, 80);
    return `error: ${sentence}`;
  }
  if (DONE_RE.test(lower)) return 'completed';
  return '';
}

// ---- Main builder ----

export interface ConversationSummary {
  lastGoal: string;
  filesInContext: string[];
  status: string;
}

function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (typeof b === 'object' && b !== null && 'text' in b) return String((b as { text: unknown }).text);
        return '';
      })
      .join(' ');
  }
  return '';
}

/**
 * Build a compact CONVERSATION_MEMORY block from the last few turns.
 * Returns '' when there is no prior context (first message in session).
 *
 * @param history  Full message history EXCLUDING the current user message.
 * @param tracker  Optional ExecutionTracker — merges its filesModified set.
 */
export function buildConversationMemory(
  history: ChatMessage[],
  tracker?: ExecutionTracker,
): string {
  // Need at least one prior turn to produce useful context.
  if (!history.length) return '';

  const recent = history.slice(-(TURNS_TO_SCAN * 2)); // last N pairs

  // Extract previous user goals (all user messages in the window, oldest first)
  const userGoals: string[] = [];
  for (const msg of recent) {
    if (msg.role !== 'user') continue;
    const text = contentText(msg.content).trim();
    const firstLine = text.split('\n')[0].trim();
    if (firstLine && firstLine.length > 3) {
      userGoals.push(firstLine.slice(0, MAX_GOAL_CHARS));
    }
  }

  // File paths from ALL recent messages
  const filePaths = new Set<string>();
  for (const msg of recent) {
    for (const p of extractFilePaths(contentText(msg.content))) {
      filePaths.add(p);
    }
  }

  // Merge files from ExecutionTracker (ground truth of what was actually written)
  if (tracker && !tracker.isEmpty) {
    for (const f of tracker.modifiedFiles) {
      filePaths.add(f);
    }
  }

  // Status from last assistant message
  let status = '';
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'assistant') {
      status = extractStatus(contentText(recent[i].content));
      break;
    }
  }

  // Nothing useful to report
  if (!userGoals.length && !filePaths.size) return '';

  const lines: string[] = ['## CONVERSATION_MEMORY'];

  if (userGoals.length) {
    // Most recent goal = the prior user turn
    lines.push(`Previous goal: ${userGoals[userGoals.length - 1]}`);
    // If there's an older goal too, show it as "original goal" for deeper context
    if (userGoals.length > 1) {
      lines.push(`Original task: ${userGoals[0]}`);
    }
  }

  if (filePaths.size) {
    lines.push('Files in context:');
    for (const f of [...filePaths].slice(0, MAX_FILES)) {
      lines.push(`- ${f}`);
    }
    if (filePaths.size > MAX_FILES) {
      lines.push(`(+${filePaths.size - MAX_FILES} more)`);
    }
  }

  if (status) {
    lines.push(`Status: ${status}`);
  }

  lines.push('Use this context — do NOT re-search for these files unless the user asks.');

  return lines.join('\n');
}

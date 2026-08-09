import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-session memory of WHAT THE AGENT HAS ALREADY ESTABLISHED — the one thing the architecture
 * otherwise throws away.
 *
 * The AI SDK is stateless: every turn re-sends `{system, messages}` and nothing else persists. On
 * top of that, TierMux deliberately discards the expensive half of its own history — `prepareStep`
 * prunes tool results older than two messages once past `pruneAtTokens`, and `condenseHistory`
 * replaces everything but the recent tail with an LLM summary. The net effect is that what the
 * agent SAID survives and what it READ does not, so turn 2 re-hunts for files turn 1 already
 * found. That was observed directly (2026-08-09 human simulation): after reading the router in
 * turn 1, the follow-up turn made zero tool calls and asked the user what they wanted instead.
 *
 * This note is the counterweight. It is deliberately tiny (paths, not contents) so it can live in
 * the SYSTEM prompt, which is rebuilt every turn and therefore immune to both pruning and
 * compaction.
 *
 * Hard rule: a path is recorded ONLY if it exists on disk right now. A findings note is an
 * assertion the model will trust for the rest of the session, so admitting an invented path would
 * promote a one-off hallucination into a standing fact.
 */

/** Kept small on purpose: this is a pointer list, not a cache. ~40 paths is well under 2KB. */
const MAX_PATHS = 40;

interface SessionNote {
  /** Workspace-relative path → the best line reference seen for it, if any. */
  files: Map<string, number | undefined>;
}

const notes = new Map<string, SessionNote>();

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** `src/agent/core/loop.ts:120` or bare `src/agent/core/loop.ts` — nested paths only, so prose
 *  words with a dot ("e.g", "v2.1") can't be mistaken for files. */
const PATH_CITATION = /\b((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,5})(?::(\d{1,6}))?\b/g;

/** Paths cited in prose, deduped, keeping the first line number seen for each. */
function citedPaths(text: string): Array<{ file: string; line?: number }> {
  const out = new Map<string, number | undefined>();
  let m: RegExpExecArray | null;
  PATH_CITATION.lastIndex = 0;
  while ((m = PATH_CITATION.exec(text)) !== null) {
    const file = m[1].replace(/^\.\//, '');
    if (!out.has(file)) out.set(file, m[2] ? Number(m[2]) : undefined);
  }
  return [...out].map(([file, line]) => ({ file, line }));
}

/**
 * Fold this turn's evidence into the session note. `openedFiles` are paths the agent actually
 * passed to a read/search tool; `answerText` contributes the `path:line` references it chose to
 * cite. Both are filtered against the filesystem before anything is stored.
 */
export function recordFindings(sessionId: string | undefined, openedFiles: string[], answerText: string): void {
  if (!sessionId) return;
  const root = workspaceRoot();
  if (!root) return;

  const note = notes.get(sessionId) ?? { files: new Map<string, number | undefined>() };
  const add = (file: string, line?: number): void => {
    const rel = file.replace(/^\.\//, '').replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.includes('..')) return; // never record an escape-looking path
    try {
      if (!fs.statSync(path.join(root, rel)).isFile()) return;
    } catch {
      return; // does not exist — the whole point of this guard
    }
    // A later, more specific citation (with a line) upgrades an earlier bare mention.
    if (!note.files.has(rel) || (line !== undefined && note.files.get(rel) === undefined)) {
      note.files.set(rel, line);
    }
  };

  for (const f of openedFiles) add(f);
  for (const { file, line } of citedPaths(answerText)) add(file, line);

  // Oldest-out when over the cap: Map preserves insertion order, and the files that matter most
  // are usually the ones the session has touched most recently.
  while (note.files.size > MAX_PATHS) {
    const oldest = note.files.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    note.files.delete(oldest);
  }
  notes.set(sessionId, note);
}

/** The block appended to the system prompt, or '' when this session has established nothing. */
export function findingsPrompt(sessionId: string | undefined): string {
  if (!sessionId) return '';
  const note = notes.get(sessionId);
  if (!note || note.files.size === 0) return '';
  const lines = [...note.files].map(([f, l]) => `- ${f}${l ? `:${l}` : ''}`);
  return '\n\n## Already established in this conversation\n'
    + 'These workspace files have already been located and read in an EARLIER turn of this same '
    + 'conversation, and each one was verified to exist. Their contents are no longer in your '
    + 'message history — that is expected, not a sign they were wrong.\n'
    + `${lines.join('\n')}\n`
    + 'Do not re-run a broad search to rediscover them: read the relevant one directly. If the '
    + 'user is correcting or following up on earlier work, it almost certainly concerns a file in '
    + 'this list.';
}

/** Forget a session's note — call on session delete so it cannot outlive the conversation. */
export function clearFindings(sessionId: string): void {
  notes.delete(sessionId);
}

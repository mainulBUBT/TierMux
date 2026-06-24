// Deterministic VM context layer.
// Assembles a budget-capped structured context block BEFORE the LLM call.
//
// Strict injection priority (high → low):
//   1. SYMBOL_HITS  — O(1) exact anchors, highest signal
//   2. LAST_ERROR   — most urgent signal for bug/fix tasks
//   3. GIT_DIFF     — recent change context (capped to 10 lines)
//   4. ACTIVE_FILE  — only injected if symbols don't already cover it (capped to 400 chars)
//   5. LAST_ATTEMPT — failure memory so model doesn't repeat broken patches
//
// Budget: ~1500 tokens total. Free models choke above this.
// LLM does NOT search. LLM does NOT plan. LLM renders diff/explanation only.

import * as vscode from 'vscode';
import * as cp from 'child_process';

// ---- Budget constants ----
// Hard cap: ~1500 tokens total = ~6000 chars. Free models choke above this.
// Sections are added in priority order and dropped when budget is exhausted.
const TOKEN_BUDGET = 1500;
const CHARS_PER_TOKEN = 4;
const CHAR_BUDGET = TOKEN_BUDGET * CHARS_PER_TOKEN; // 6000 chars

const MAX_SYMBOL_COUNT = 3;
const MAX_DIFF_LINES = 10;
const MAX_ERROR_COUNT = 1;
const MAX_ACTIVE_FILE_CHARS = 400;
const MAX_GOAL_CHARS = 300;

// ---- Failure memory (in-process, per session) ----

interface FailureRecord {
  attempt: string;
  reason: string;
  ts: number;
}

const failureMemory = new Map<string, FailureRecord>();
const FAILURE_TTL_MS = 30 * 60 * 1000; // 30 min

export function recordFailure(sessionId: string, attempt: string, reason: string): void {
  failureMemory.set(sessionId, { attempt, reason, ts: Date.now() });
}

export function clearFailure(sessionId: string): void {
  failureMemory.delete(sessionId);
}

function getFailure(sessionId: string): FailureRecord | undefined {
  const rec = failureMemory.get(sessionId);
  if (!rec) return undefined;
  if (Date.now() - rec.ts > FAILURE_TTL_MS) { failureMemory.delete(sessionId); return undefined; }
  return rec;
}

// ---- Active file (budget-capped) ----

export interface ActiveFileContext {
  path: string;
  languageId: string;
  content: string;
  cursorLine: number;
}

export function getActiveFile(): ActiveFileContext | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file') return undefined;
  const path = vscode.workspace.asRelativePath(ed.document.uri);
  const cur = ed.selection.active.line;
  // Tight window — ±10 lines around cursor, not ±60. Budget is king.
  const start = Math.max(0, cur - 10);
  const end = Math.min(ed.document.lineCount, cur + 10);
  const content = ed.document.getText(new vscode.Range(start, 0, end, 0)).slice(0, MAX_ACTIVE_FILE_CHARS);
  return { path, languageId: ed.document.languageId, content, cursorLine: cur + 1 };
}

// ---- Last error (1 error only — highest priority signal) ----

export async function getLastError(): Promise<string> {
  const diagnostics = vscode.languages.getDiagnostics();
  for (const [uri, diags] of diagnostics) {
    const rel = vscode.workspace.asRelativePath(uri);
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        return `${rel}:${d.range.start.line + 1} — ${d.message}`;
      }
    }
  }
  return '';
}

// ---- Git diff (capped to 10 lines) ----

function execGit(args: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    cp.exec(`git ${args}`, { cwd, timeout: 3000, maxBuffer: 16 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

export async function getGitDiff(): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return '';
  const diff = await execGit('diff --unified=1 HEAD', root);
  // Keep only the first MAX_DIFF_LINES changed lines (lines starting with + or -)
  const lines = diff.split('\n');
  const kept: string[] = [];
  let changeLines = 0;
  for (const line of lines) {
    kept.push(line);
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      changeLines++;
    }
    if (changeLines >= MAX_DIFF_LINES) break;
  }
  return kept.join('\n');
}

// ---- VM Context block assembler ----

export interface VmContextInput {
  /** Pre-computed symbol hits string (from symbolIndex + bundleCache). */
  symbolHits: string;
  /** The user's original query. */
  goal: string;
  /** Session ID for failure memory lookup. */
  sessionId?: string;
}

/**
 * Assembles the budget-capped VM context block.
 * Priority order: SYMBOL_HITS > LAST_ERROR > GIT_DIFF > ACTIVE_FILE > LAST_ATTEMPT
 * Total budget: ~1500 tokens. Sections are skipped when budget is tight.
 */
export async function buildVmContext(input: VmContextInput): Promise<string> {
  const [lastError, gitDiff] = await Promise.all([
    getLastError(),
    getGitDiff(),
  ]);
  const activeFile = getActiveFile();
  const failure = input.sessionId ? getFailure(input.sessionId) : undefined;

  // Budget-aware assembler: add sections in priority order, drop when over cap.
  const sections: string[] = [];
  let spent = 0;

  const tryAdd = (section: string): boolean => {
    if (spent + section.length > CHAR_BUDGET) return false;
    sections.push(section);
    spent += section.length;
    return true;
  };

  // GOAL always fits (capped to MAX_GOAL_CHARS)
  tryAdd(`## GOAL\n${input.goal.trim().slice(0, MAX_GOAL_CHARS)}`);

  // 1. SYMBOL_HITS — highest signal, always try first
  if (input.symbolHits) {
    const lines = input.symbolHits.trim().split('\n').slice(0, MAX_SYMBOL_COUNT + 2);
    tryAdd(`## SYMBOL_HITS\n${lines.join('\n')}`);
  }

  // 2. LAST_ERROR — urgent; prefer over diff and file
  if (lastError) {
    tryAdd(`## LAST_ERROR\n${lastError.split('\n').slice(0, MAX_ERROR_COUNT).join('\n')}`);
  }

  // 3. LAST_ATTEMPT — failure memory; small, high value for retry loops
  if (failure) {
    tryAdd(`## LAST_ATTEMPT (failed — do NOT repeat this)\n${failure.attempt.slice(0, 200)}\nReason: ${failure.reason.slice(0, 100)}`);
  }

  // 4. GIT_DIFF — recent changes (10 lines max, ~300 chars)
  if (gitDiff) {
    tryAdd(`## GIT_DIFF\n\`\`\`diff\n${gitDiff}\n\`\`\``);
  }

  // 5. ACTIVE_FILE — skip if symbols already anchor to this file or budget is tight
  if (activeFile && !input.symbolHits.includes(activeFile.path)) {
    tryAdd(
      `## ACTIVE_FILE\n${activeFile.path}:${activeFile.cursorLine}\n\`\`\`${activeFile.languageId}\n${activeFile.content}\n\`\`\``,
    );
  }

  return sections.join('\n\n');
}

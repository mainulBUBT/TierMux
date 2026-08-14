

// The permission POLICY — not the gate. The AI SDK's own `toolApproval` mechanism (a call-level
// option to streamText/generateText) is the gate: a denied verdict here means the tool's
// execute() never runs at all (verified empirically against ai@7.0.34 — see the plan's spike
// note). This file only decides allow/ask/deny; it never touches execution.
import * as vscode from 'vscode';
import type { AgentOpts } from '../../agent';
import { isReadOnlyCommand } from '../../../edits/commandClassify';
import { isDangerous } from '../../../edits/commandGate';
import { resolveWorkspacePath } from '../tools/resolvePath';

/** Tools that mutate the workspace or run arbitrary commands — excluded from plan/ask mode's
 *  tool set entirely (see tools/index.ts) and denied here too as defense in depth. `implementPipeline`
 *  is included because its EFFECT is mutating (workers write files; merge rewrites a branch) even
 *  though the tool itself only orchestrates — so it should be gated out of plan/ask and surfaced in
 *  the main turn's approval flow like the other mutating tools. */
export const MUTATING_TOOLS = new Set(['writeFile', 'createFile', 'editFile', 'deleteFile', 'runCommand', 'implementPipeline']);

/** Tools with a side effect that's low-risk enough to auto-approve (not in MUTATING_TOOLS, so no
 *  approval prompt), but that Plan mode should still not expose — plan mode must produce zero
 *  side effects, even small ones like writing a memory note. Kept separate from MUTATING_TOOLS
 *  because that set also drives the approval gate above, and `remember` shouldn't require approval
 *  in agent mode. */
export const PLAN_MODE_EXTRA_EXCLUDED_TOOLS = new Set(['remember']);

/** Content-reading tools that take a workspace path — the ones a secrets read can leak through. */
const CONTENT_READ_TOOLS = new Set(['readFile', 'grep']);

/** Path patterns that commonly hold secrets. Matched against workspace-relative paths, so this
 *  catches `.env` at any depth without also matching e.g. `src/env.ts`. */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa(\.[^/]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /credentials/i,
];

function findSensitivePath(paths: string[]): string | undefined {
  return paths.find((p) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(p)));
}

/** A bare `env` / `printenv` dumps every environment variable — API keys included — straight into
 *  the model context. Matched as a whole command segment so `env NODE_ENV=x node app.js` (which
 *  runs a program rather than printing the environment) doesn't trip it. */
const ENV_DUMP_RE = /(^|[;&|]\s*)(printenv\b|env\s*($|[;&|]))/;

/** The secrets check applied to `runCommand`, mirroring the CONTENT_READ_TOOLS gate on
 *  readFile/grep. Without it the file gate was trivially bypassable: `cat .env`,
 *  `grep -r AWS_SECRET .`, `cat ~/.ssh/id_rsa` and `printenv` are all classified read-only by
 *  isReadOnlyCommand (cat/grep/env/printenv are in its ALWAYS_READ_ONLY set), so they were
 *  auto-approved below with NO prompt at all — while `readFile('.env')` correctly asked. That
 *  asymmetry matters more here than in most agents: nothing redacts tool output, so the contents
 *  land in the model context and are shipped to whichever free third-party provider is routed,
 *  several of which train on submitted data. Returns the offending token, or undefined.
 *  Deliberately errs toward false positives — the cost is one extra approval prompt. */
function commandTouchesSecrets(command: string): string | undefined {
  if (!command) return undefined;
  if (ENV_DUMP_RE.test(command)) return 'the environment (may contain API keys)';
  // Split on shell separators AND `=` so `--file=.env` is inspected as `.env`.
  return findSensitivePath(command.split(/[\s'"=]+/).filter(Boolean));
}

/** Mutating tools that rewrite an EXISTING file's content — the ones a blind edit destroys work
 *  through. `createFile` is excluded: a new file has nothing to read first. */
const REWRITE_TOOLS = new Set(['writeFile', 'editFile', 'deleteFile']);

function toolPaths(input: unknown): string[] {
  const p = (input as { path?: string | string[] })?.path;
  return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : typeof p === 'string' ? [p] : [];
}

function pathKey(relPath: string): string | undefined {
  try { return resolveWorkspacePath(relPath).toString(); } catch { return undefined; }
}

async function fileExists(uri: string): Promise<boolean> {
  try { await vscode.workspace.fs.stat(vscode.Uri.parse(uri)); return true; } catch { return false; }
}

interface ToolApprovalStatusObject { type: 'approved' | 'denied' | 'not-applicable' | 'user-approval'; reason?: string }
type ToolApprovalStatus = ToolApprovalStatusObject | 'approved' | 'denied' | 'not-applicable' | undefined;

interface ApprovalToolCall {
  toolName: string;
  input: unknown;
}

/**
 * Approval policy for NESTED sub-agents — currently `explore`, which runs its own generateText
 * loop over readFile/grep/glob/listDir. That loop passed no `toolApproval` at all, so the whole
 * policy below simply never applied to it: `explore("look at the config")` could read `.env`,
 * `id_rsa` or `.aws/credentials` with no gate whatsoever, a second independent path around the
 * CONTENT_READ_TOOLS check. Denies outright instead of prompting — a sub-agent has no UI to show
 * an approval card from, and the parent agent can still read the file through the prompted path
 * if it genuinely needs to.
 */
export function createSubAgentToolApproval() {
  return async ({ toolCall }: { toolCall: ApprovalToolCall }): Promise<ToolApprovalStatus> => {
    if (MUTATING_TOOLS.has(toolCall.toolName)) {
      return { type: 'denied', reason: `"${toolCall.toolName}" is not available inside explore.` };
    }
    const hit = findSensitivePath(toolPaths(toolCall.input));
    if (hit) {
      return { type: 'denied', reason: `"${hit}" looks like a secrets file — report that it exists instead of reading it.` };
    }
    return 'approved';
  };
}

/** Git subcommands that are unambiguously READ-ONLY — safe for a worker to run for inspection
 *  (`git status`, `git diff`, `git log`). Everything else git is treated as mutating and denied,
 *  because `git` subcommands are a mix of read and write forms (e.g. `git branch` lists but
 *  `git branch -d` deletes; `git tag` lists but `git tag -a` creates) and an allowlist is safer
 *  than a denylist that could miss a new destructive subcommand. A worker running `git commit`,
 *  `git checkout`, or `git push` would disrupt the orchestrator's worktree/branch lifecycle, so
 *  only this tight read-only set passes. */
const GIT_READONLY = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'blame', 'grep', 'rev-parse',
  'cat-file', 'ls-tree', 'for-each-ref', 'reflog', 'shortlog', 'describe',
  'symbolic-ref', 'ls-remote', 'annotate', 'name-rev',
]);

/** Returns the git subcommand token if `command` is a git invocation, else undefined. Handles
 *  leading env-assignments and `git -c key=val` global flags so `git -c x=y commit` is still caught. */
function gitSubcommand(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  let i = tokens.findIndex((t) => /^git(\.exe)?$/.test(t));
  if (i < 0) return undefined;
  i++;
  // Skip global git flags that take a value (-c, -C, --git-dir, --work-tree, -l, etc.) so we land
  // on the real subcommand. Bare flags like -p are skipped too.
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (/^-(-git-dir|--work-tree|--namespace|-c|-C|-b|-l|-p)$/.test(tokens[i]) && i + 1 < tokens.length) i += 2;
    else i++;
  }
  return tokens[i];
}

/** True if `command` is a git invocation whose subcommand is NOT in the read-only allowlist. */
export function isMutatingGit(command: string): boolean {
  const sub = gitSubcommand(command);
  return !!sub && !GIT_READONLY.has(sub);
}

/**
 * Approval policy for a fleet-pipeline WORKER sub-agent — the write-capable counterpart to
 * `createSubAgentToolApproval`. Unlike explore, a worker MUST edit files (writeFile/editFile/etc.),
 * so this does NOT blanket-deny MUTATING_TOOLS. It keeps the safety gates that still matter under a
 * worker, all as hard DENYs (a worker has no UI to prompt from):
 *   - secrets-path reads (CONTENT_READ_TOOLS) — a worker scoped to a worktree can still see `.env`;
 *   - secrets-reading or dangerous commands (commandTouchesSecrets / isDangerous);
 *   - mutating git (isMutatingGit) — the orchestrator owns the worktree/branch lifecycle, so a
 *     worker must not commit, branch, push, or otherwise reshape git state;
 *   - read-before-edit (REWRITE_TOOLS) — a weak worker blindly clobbering a file it never read is
 *     the exact failure mode this gate exists for.
 * Everything else is approved outright. No `onPermissionAsk` path is reachable because every gated
 * branch denies instead of prompting, so the worker runs fully autonomously.
 */
export function createWorkerToolApproval() {
  const readPaths = new Set<string>();
  const blindEditDenials = new Set<string>();
  return async ({ toolCall }: { toolCall: ApprovalToolCall }): Promise<ToolApprovalStatus> => {
    const name = toolCall.toolName;

    if (name === 'readFile') for (const p of toolPaths(toolCall.input)) { const k = pathKey(p); if (k) readPaths.add(k); }

    if (CONTENT_READ_TOOLS.has(name)) {
      const hit = findSensitivePath(toolPaths(toolCall.input));
      if (hit) return { type: 'denied', reason: `"${hit}" looks like a secrets file.` };
    }

    if (name === 'runCommand') {
      const command = typeof (toolCall.input as { command?: unknown })?.command === 'string'
        ? (toolCall.input as { command: string }).command
        : '';
      const secretHit = commandTouchesSecrets(command);
      if (secretHit) return { type: 'denied', reason: `Command reads ${secretHit}.` };
      if (command && isDangerous(command)) return { type: 'denied', reason: 'Dangerous command pattern.' };
      if (command && isMutatingGit(command)) {
        return { type: 'denied', reason: 'The orchestrator manages git for the pipeline — do not run mutating git commands.' };
      }
    }

    if (REWRITE_TOOLS.has(name)) {
      const target = toolPaths(toolCall.input)[0];
      const key = target ? pathKey(target) : undefined;
      if (key && !readPaths.has(key) && !blindEditDenials.has(key) && await fileExists(key)) {
        blindEditDenials.add(key);
        return {
          type: 'denied',
          reason: `You have not read "${target}" yet. Call readFile on it first, then retry — editing from a guess corrupts the file.`,
        };
      }
      if (key) readPaths.add(key);
    }

    return 'approved';
  };
}

/**
 * Creates the AI SDK `toolApproval` function for one turn. Same decisions the previous
 * hand-rolled permission checks made — mode gate, live read-only command classification,
 * dangerous-pattern override, and the existing `onPermissionAsk` UI callback — now enforced by
 * the SDK itself.
 */
export function createToolApproval(opts: AgentOpts) {
  // Per-turn read ledger, closed over so it can't leak between turns. Backs the read-before-edit
  // gate below: prose alone ("read the file first") never stopped a weak model from opening with
  // a blind editFile on a file it had only guessed the contents of.
  const readPaths = new Set<string>();
  const blindEditDenials = new Set<string>();

  return async ({ toolCall }: { toolCall: ApprovalToolCall }): Promise<ToolApprovalStatus> => {
    const name = toolCall.toolName;

    if (name === 'readFile') for (const p of toolPaths(toolCall.input)) { const k = pathKey(p); if (k) readPaths.add(k); }

    if (opts.mode !== 'agent' && MUTATING_TOOLS.has(name)) {
      return { type: 'denied', reason: `"${name}" is not available in ${opts.mode} mode.` };
    }

    if (CONTENT_READ_TOOLS.has(name)) {
      const input = toolCall.input as { path?: string | string[] };
      const paths = Array.isArray(input?.path) ? input.path : input?.path ? [input.path] : [];
      const hit = findSensitivePath(paths);
      if (hit) {
        if (!opts.onPermissionAsk) return { type: 'denied', reason: `"${hit}" looks like a secrets file.` };
        const resp = await opts.onPermissionAsk({
          title: `This tool wants to read the secrets-looking file`,
          pattern: hit,
          toolName: name,
        });
        return resp === 'reject' ? { type: 'denied', reason: `"${hit}" looks like a secrets file.` } : 'approved';
      }
    }

    if (!MUTATING_TOOLS.has(name)) return 'approved';

    if (REWRITE_TOOLS.has(name)) {
      const target = toolPaths(toolCall.input)[0];
      const key = target ? pathKey(target) : undefined;
      // Denied once per path, then allowed — the deny is a nudge to go read, not a deadlock a
      // weak model can get permanently stuck behind.
      if (key && !readPaths.has(key) && !blindEditDenials.has(key) && await fileExists(key)) {
        blindEditDenials.add(key);
        return {
          type: 'denied',
          reason: `You have not read "${target}" this turn. Call readFile on it first, then retry this ${name} — editing from a guess at its contents corrupts the file.`,
        };
      }
      if (key) readPaths.add(key); // proceeding means its contents are now known/replaced
    }

    if (name === 'runCommand') {
      const command = typeof (toolCall.input as { command?: unknown })?.command === 'string'
        ? (toolCall.input as { command: string }).command
        : '';
      // Checked BEFORE the read-only fast path below — a secrets-reading command is precisely the
      // kind that classifies as read-only, so ordering is what makes this gate effective at all.
      const secretHit = commandTouchesSecrets(command);
      if (secretHit) {
        const reason = `This command reads ${secretHit}.`;
        if (!opts.onPermissionAsk) return { type: 'denied', reason };
        const resp = await opts.onPermissionAsk({
          title: 'This tool wants to run a command that reads secrets',
          pattern: secretHit,
          command,
          toolName: name,
        });
        return resp === 'reject' ? { type: 'denied', reason } : 'approved';
      }
      if (command && isReadOnlyCommand(command) && !isDangerous(command)) return 'approved';
    }

    if (!opts.onPermissionAsk) return 'approved'; // no gate wired (e.g. a test harness) — allow
    // Lead-in sentence + the command/path shown separately (as `pattern`, rendered as an inline
    // code chip by the webview) — mirrors the AI Elements Confirmation reference ("This tool
    // wants to delete the file `path`. Do you approve this action?") instead of a bare
    // "editFile — apply this change?" that never named WHICH file.
    const input = toolCall.input as { command?: string; path?: string };
    const title = name === 'runCommand' ? 'This tool wants to run the command'
      : name === 'deleteFile' ? 'This tool wants to delete the file'
      : name === 'editFile' ? 'This tool wants to apply changes to the file'
      : 'This tool wants to write to the file';
    const pattern = name === 'runCommand' ? input.command : input.path;
    const command = name === 'runCommand' ? input.command : undefined;
    const resp = await opts.onPermissionAsk({ title, pattern, command, toolName: name });
    return resp === 'reject' ? { type: 'denied' } : 'approved';
  };
}

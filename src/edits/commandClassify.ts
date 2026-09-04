

import { parse, type ParseEntry } from 'shell-quote';

/**
 * Binaries that are read-only no matter what arguments they're given (flags only ever narrow
 * what they read, never cause a write) — deliberately excludes anything ambiguous (`npm`, `git`,
 * `node`, `docker`, `make`...) where the SAME binary name can mutate depending on subcommand;
 * those are either handled as a special case below (`git`, `find`) or just never classified as
 * read-only, falling through to normal approval gating.
 */
const ALWAYS_READ_ONLY = new Set([
  'ls', 'pwd', 'whoami', 'date', 'env', 'printenv', 'uname', 'which', 'type', 'hostname', 'id',
  'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df', 'ps', 'echo',
  'grep', 'egrep', 'fgrep',
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'ls-files', 'blame', 'rev-parse', 'describe', 'shortlog',
]);

/**
 * Destructive patterns that always prompt for confirmation, even when Auto-approve
 * is on — a safety net so unattended runs can't silently wipe data or rewrite history.
 * Lives here (not commandGate.ts) so the vscode-free permission policy can share it.
 */
const DANGEROUS = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf / rm -fr / rm -r -f …
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\b.*-[a-z]*f/i,
  /\b(sudo|chmod|chown)\b/i,
  /\b(mkfs|dd|shutdown|reboot|kill(all)?)\b/i,
  /\bnpm\s+publish\b/i,
  /[>]\s*\/dev\//i, // writing to device files
  /:\s*\(\s*\)\s*\{/, // fork-bomb shape :(){ :|:& };:
];

/** True for commands too destructive to run unattended; these always ask, even in Auto-approve. */
export function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

/** The `command` argument of a runCommand tool call, or undefined when absent/not a string. */
export function commandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const c = (input as Record<string, unknown>).command;
  return typeof c === 'string' ? c : undefined;
}

const WRITE_REDIRECT_OPS = new Set(['>', '>>', '>|']);

function isSegmentReadOnly(tokens: string[]): boolean {
  if (tokens.length === 0) return true; // empty segment (e.g. trailing `;`) — harmless
  const bin = tokens[0];
  if (ALWAYS_READ_ONLY.has(bin)) return true;
  if (bin === 'find') {
    // find can mutate via -delete/-exec — only read-only when neither appears.
    return !tokens.some((t) => t === '-delete' || t === '-exec' || t === '-execdir' || t === '-fprintf');
  }
  if (bin === 'git') {
    const sub = tokens[1];
    return typeof sub === 'string' && GIT_READ_ONLY_SUBCOMMANDS.has(sub);
  }
  return false;
}

/**
 * Conservative shell-command classifier for CommandGate's live approval gate — a benign `ls`
 * or `git status` doesn't need the same approval friction as `rm -rf`, so a confidently
 * read-only command can skip the ask-flow even under `commandApproval: 'always'`. Modeled on
 * the same idea Pochi (github.com/TabbyML/pochi) uses for its runCommand tool.
 *
 * Deliberately fails closed: any command this can't confidently classify — parse failure,
 * command substitution (`` ` `` / `$(...)`), an unrecognized shell operator, output redirection,
 * or a binary/subcommand not on the curated allowlist — returns `false` (normal gating applies).
 * A false negative here just means one extra approval prompt for something that was actually
 * safe; a false positive would mean a mutating command silently skipping approval, which this
 * function must never produce.
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return true;
  if (/`|\$\(/.test(cmd)) return false; // command substitution can hide anything — don't parse around it

  let parsed: ParseEntry[];
  try {
    parsed = parse(cmd);
  } catch {
    return false;
  }

  const segments: string[][] = [[]];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      segments[segments.length - 1].push(entry);
      continue;
    }
    const withPattern = entry as { pattern?: unknown };
    if (typeof withPattern.pattern === 'string') {
      segments[segments.length - 1].push(withPattern.pattern); // glob token — harmless as text
      continue;
    }
    const op = (entry as { op?: string }).op;
    if (op && WRITE_REDIRECT_OPS.has(op)) return false;
    if (op === '&&' || op === '||' || op === ';' || op === '|') {
      segments.push([]);
      continue;
    }
    return false; // background `&`, subshell, or any other shape we don't confidently understand
  }

  return segments.every(isSegmentReadOnly);
}

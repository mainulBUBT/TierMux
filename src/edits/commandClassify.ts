

import { parse, type ParseEntry } from 'shell-quote';

/** Binaries that are read-only whatever their arguments. Deliberately excludes anything whose
 *  subcommand can mutate (`npm`, `git`, `node`, `docker`, `make`); `git`/`find` are special-cased
 *  below, the rest fall through to normal approval. */
const ALWAYS_READ_ONLY = new Set([
  'ls', 'pwd', 'whoami', 'date', 'env', 'printenv', 'uname', 'which', 'type', 'hostname', 'id',
  'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df', 'ps', 'echo',
  'grep', 'egrep', 'fgrep',
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'ls-files', 'blame', 'rev-parse', 'describe', 'shortlog',
]);

/** Destructive patterns that always prompt, even under Auto-approve. */
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

/** Safe-by-default inspection/test/build commands that `commandApproval: 'allowlist'` runs
 *  without a prompt; `agent.commandAllowlist` adds the user's own prefixes. */
export const DEFAULT_COMMAND_ALLOWLIST = [
  'npm test', 'npm run', 'yarn test', 'pnpm test',
  'git status', 'git diff', 'git log', 'git branch', 'git show',
  'ls', 'pwd', 'cat', 'echo', 'tsc', 'node -v', 'npm -v',
  'pytest', 'go test', 'go build', 'cargo test', 'cargo check', 'cargo build',
  'php artisan test', 'composer test', 'make',
];

/** True when `command` equals or starts with one of `prefixes` (prefix + space). */
export function matchesAllowlist(command: string, prefixes: Iterable<string>): boolean {
  const cmd = command.trim();
  for (const p of prefixes) {
    const pre = p.trim();
    if (pre && (cmd === pre || cmd.startsWith(pre + ' '))) return true;
  }
  return false;
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

/** Conservative read-only classifier: a confidently read-only command skips the approval prompt.
 *  Fails closed — a parse failure, substitution, unknown operator, redirection or unlisted
 *  binary returns false. A false negative costs one prompt; a false positive skips approval
 *  for a mutating command, which this must never do. */
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

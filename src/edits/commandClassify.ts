

import { parse, type ParseEntry } from 'shell-quote';

/** Binaries that are read-only whatever their arguments. Deliberately excludes anything whose
 *  subcommand can mutate (`npm`, `git`, `node`, `docker`, `make`); `git`/`find` are special-cased
 *  below, the rest fall through to normal approval. */
const ALWAYS_READ_ONLY = new Set([
  'ls', 'pwd', 'whoami', 'date', 'uname', 'which', 'type', 'hostname', 'id',
  'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df', 'ps', 'echo',
  'grep', 'egrep', 'fgrep',
]);

/** Read-only binaries that read whatever path they are handed: "read-only" must also mean
 *  "inside the workspace", or `cat ~/.ssh/id_rsa` runs unattended (sub-agents have no prompt). */
const PATH_READERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'grep', 'egrep', 'fgrep']);

function leavesWorkspace(token: string): boolean {
  return /^[/~]/.test(token) || /(^|\/)\.\.(\/|$)/.test(token);
}

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'blame', 'rev-parse', 'describe', 'shortlog',
]);
const GIT_BRANCH_LIST_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--list', '--show-current']);

/** Destructive patterns that always prompt, even under Auto-approve. */
const DANGEROUS = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf / rm -fr / rm -r -f …
  /\brm\b.*\s--(recursive|force)\b/i,
  /\bfind\b.*\s(-delete|-exec\s+rm)\b/i,
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\b.*-[a-z]*f/i,
  /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, // discards every uncommitted change
  /\bgit\s+branch\s+.*-[a-z]*D\b/i,
  /\bgit\s+stash\s+(drop|clear)\b/i,
  /\bgit\s+remote\s+set-url\b/i,
  /\b(sudo|chmod|chown)\b/i,
  /\b(mkfs|dd|shutdown|reboot|kill(all)?|pkill|truncate|shred|diskutil|launchctl)\b/i,
  /\bcrontab\s+-r\b/i,
  /\bnpm\s+publish\b/i,
  /\b(curl|wget)\b.*\|\s*(ba|z|da)?sh\b/i, // download-and-execute
  /\b(ba|z|da)?sh\s+-c\b/i, // wraps any command the patterns above would catch
  /\beval\b/,
  /[>]\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b)/i, // writing to device files (not `2>/dev/null`)
  /[>]\s*\/etc\//i,
  /[>]\s*~?\/?(\.[a-z_]*rc|\.(bash_)?profile|\.zprofile|\.gitconfig|\.ssh\/)/i, // shell/ssh dotfiles
  /:\s*\(\s*\)\s*\{/, // fork-bomb shape :(){ :|:& };:
];

/** True for commands too destructive to run unattended; these always ask, even in Auto-approve. */
export function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

/** The short list that still asks under Auto-approve (2026-11-12, owner: "auto-approve on means
 *  full permission — ask only for the most dangerous"). isDangerous also flags routine dev work
 *  (`kill` a port, `chmod +x`, `rm -rf node_modules`, `sh -c`), which made Auto-approve keep
 *  asking. This tier is what cannot be undone and reaches past the project: the machine, the
 *  user's uncommitted work, a remote, a registry. */
const CATASTROPHIC = [
  /\bsudo\b/i,
  /\b(mkfs(\.\w+)?|shutdown|reboot|halt|poweroff|shred)\b/i,
  /\bdiskutil\s+(erase\w*|partition\w*|zero\w*|secureErase)\b/i,
  /\bdd\b[^|;&]*\bof=\/dev\//i,
  /\bgit\s+push\b.*(--force|-f\b|--mirror|--delete\b)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\b.*-[a-z]*f/i,
  /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i,
  /\bgit\s+stash\s+(drop|clear)\b/i,
  /\bgit\s+remote\s+set-url\b/i,
  /\b(npm|pnpm|yarn|cargo)\s+publish\b/i,
  /\bcrontab\s+-r\b/i,
  /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
  /[>]\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b)/i,
  /[>]\s*\/etc\//i,
  /[>]\s*~?\/?(\.[a-z_]*rc|\.(bash_)?profile|\.zprofile|\.gitconfig|\.ssh\/)/i,
  /:\s*\(\s*\)\s*\{/,
  /\b(chmod|chown)\b[^|;&]*\s-[a-zA-Z]*R[a-zA-Z]*\b[^|;&]*\s(\/|~|\$HOME)/i,
];

/** A delete target that reaches past the project: the filesystem root, home, a parent dir, the
 *  whole project (`.`, `*`), or an absolute path outside `workspaceRoot`. */
function deleteTargetEscapes(target: string, workspaceRoot?: string): boolean {
  const t = target.replace(/^['"]|['"]$/g, '');
  if (!t || t.startsWith('-')) return false;
  if (t === '/' || t === '.' || t === './' || t === '*' || t === './*' || t === '.*') return true;
  if (/^~|^\$\{?HOME\b/.test(t)) return true;
  if (/(^|\/)\.\.(\/|$)/.test(t)) return true;
  if (/^\/|^[A-Za-z]:[\\/]/.test(t)) {
    const root = workspaceRoot?.replace(/[\\/]+$/, '');
    return !root || !(t === root || t.startsWith(root + '/') || t.startsWith(root + '\\'));
  }
  return false;
}

/** True for the commands Auto-approve still asks about — see CATASTROPHIC. */
export function isCatastrophic(command: string, workspaceRoot?: string): boolean {
  if (CATASTROPHIC.some((re) => re.test(command))) return true;
  for (const segment of command.split(/;|&&|\|\||\|/)) {
    const tokens = segment.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''));
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'rm' || tokens[i] === 'rmdir') {
        if (tokens.slice(i + 1).some((t) => deleteTargetEscapes(t, workspaceRoot))) return true;
      }
      if (tokens[i] === 'find' && tokens.some((t) => t === '-delete' || t === '-exec' || t === '-execdir')) {
        const start = tokens[i + 1];
        if (start && !start.startsWith('-') && deleteTargetEscapes(start, workspaceRoot) && start !== '.' && start !== './') return true;
      }
    }
  }
  return false;
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
  if (PATH_READERS.has(bin)) return !tokens.slice(1).some((t) => !t.startsWith('-') && leavesWorkspace(t));
  if (ALWAYS_READ_ONLY.has(bin)) return true;
  if (bin === 'find') {
    // find can mutate via -delete/-exec — only read-only when neither appears.
    if (tokens.some((t) => t === '-delete' || t === '-exec' || t === '-execdir' || t === '-fprintf')) return false;
    return !tokens.slice(1).some((t) => !t.startsWith('-') && leavesWorkspace(t));
  }
  if (bin === 'git') {
    const sub = tokens[1];
    const rest = tokens.slice(2);
    if (rest.some((t) => t.startsWith('--output'))) return false; // `git log --output=x` writes
    if (sub === 'branch') return rest.every((t) => GIT_BRANCH_LIST_FLAGS.has(t)); // a bare name creates one
    if (sub === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
    return typeof sub === 'string' && GIT_READ_ONLY_SUBCOMMANDS.has(sub);
  }
  return false;
}

const FILE_WRITERS = new Set(['tee', 'touch', 'mkdir', 'rm', 'rmdir', 'mv', 'cp', 'ln']);

const INLINE_SCRIPT_RUNNERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php']);
const INLINE_SCRIPT_FLAGS = new Set(['-', '-c', '-e', '-E', '-r']);

/** True when the command plainly changes files, or runs an inline script, which can. Not the inverse
 *  of isReadOnlyCommand: `npm test` is neither. A command that cannot be parsed returns false, so the
 *  caller still asks. */
export function writesFiles(command: string): boolean {
  let parsed: ParseEntry[];
  try {
    parsed = parse(command.trim());
  } catch {
    return false;
  }
  let bin: string | undefined;
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry === 'string') {
      if (bin === undefined) {
        bin = entry;
        if (FILE_WRITERS.has(bin)) return true;
      } else if (bin === 'sed' && (entry.startsWith('-i') || entry === '--in-place')) return true;
      else if (bin && INLINE_SCRIPT_RUNNERS.has(bin) && INLINE_SCRIPT_FLAGS.has(entry)) return true;
      continue;
    }
    const op = (entry as { op?: string }).op;
    if (op && WRITE_REDIRECT_OPS.has(op) && parsed[i + 1] !== '/dev/null') return true;
    if (op === '<' && bin && INLINE_SCRIPT_RUNNERS.has(bin) && parsed[i + 1] && typeof parsed[i + 1] === 'object') return true; // heredoc
    if (op === '&&' || op === '||' || op === ';' || op === '|' || op === '&') bin = undefined;
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
  if (/`|\$/.test(cmd)) return false; // substitution or a variable can hide any path — don't parse around it

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

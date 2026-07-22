

/** Strips ANSI escape sequences (color codes, cursor movement) from raw terminal output —
 *  `TerminalShellExecution.read()` includes them verbatim, and feeding them to the model as
 *  tool output would just be noise. Built from character codes rather than literal escape
 *  bytes in source, to avoid depending on how any given editor/tool round-trips control
 *  characters through a text diff. */
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(0x07);
const ANSI_RE = new RegExp(
  '[' + ESC + CSI + '][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]+(?:;[a-zA-Z\\d]*)*)?' + BEL + ')'
  + '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** POSIX-shell single-quote escaping (bash/zsh/sh) — used only to `cd` into an explicitly
 *  requested working directory before a command; the command itself is sent as-is. Windows
 *  shells (PowerShell/cmd) quote differently — if `cd` fails there, the failure just surfaces
 *  as ordinary command output rather than corrupting anything. */
export function posixQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

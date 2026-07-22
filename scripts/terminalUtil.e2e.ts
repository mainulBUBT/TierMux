// Unit test for the pure string-handling helpers behind PersistentShellManager
// (src/edits/persistentShell.ts) — split into their own vscode-free module specifically so
// they're testable headlessly, since PersistentShellManager itself needs a real vscode.Terminal.
//
// Run: npm run test:e2e:terminal-util
import { stripAnsi, posixQuote } from '../src/edits/terminalUtil';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const ESC = String.fromCharCode(0x1b);

// --- stripAnsi ---
ok('plain text unchanged', stripAnsi('hello world') === 'hello world');
ok('strips color codes', stripAnsi(`${ESC}[31mred${ESC}[0m text`) === 'red text');
ok('strips cursor movement', stripAnsi(`${ESC}[2K${ESC}[1Ghello`) === 'hello');
ok('strips multiple sequences in one string', stripAnsi(`${ESC}[1m${ESC}[32mgreen bold${ESC}[0m plain`) === 'green bold plain');
ok('leaves newlines intact', stripAnsi(`${ESC}[31mline1${ESC}[0m\nline2`) === 'line1\nline2');
ok('empty string', stripAnsi('') === '');

// --- posixQuote ---
ok('simple path', posixQuote('/tmp/foo') === "'/tmp/foo'");
ok('path with spaces', posixQuote('/tmp/my project') === "'/tmp/my project'");
ok('path with single quote', posixQuote("/tmp/it's here") === "'/tmp/it'\\''s here'");
ok('quoted path is a single POSIX-safe token (round-trips via a shell-like split)', (() => {
  // Reconstruct what a POSIX shell would see: strip the outer quotes and undo the '\'' escape.
  const quoted = posixQuote("weird 'quoted' path");
  const unquoted = quoted.slice(1, -1).replace(/'\\''/g, "'");
  return unquoted === "weird 'quoted' path";
})());

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

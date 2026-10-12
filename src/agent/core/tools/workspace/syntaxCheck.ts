// Per-file parse check after a write: the language's own checker on THAT file, so a parse error
// reaches the model in the same tool result — with no language server and no test suite. Silent
// on success, on unchecked extensions, and when the checker is not installed.

import { execFile } from 'child_process';
import * as path from 'path';
import { hasOnPath } from './verifyCommand';

/** ast.parse rather than py_compile: py_compile writes __pycache__ into the user's project. */
const PY_PARSE = 'import ast,sys\ntry: ast.parse(open(sys.argv[1],"rb").read(), sys.argv[1])\n'
  + 'except SyntaxError as e: print(f"{e.filename}:{e.lineno}:{e.offset}: {e.msg}"); sys.exit(1)';

/** JS/TS/JSON stay with VS Code's built-in servers: `node --check` misreads JSX and JSONC, and a
 *  false parse error would push the model to "fix" valid code. `parse` must appear in the output:
 *  a non-zero exit alone can be the runtime failing (a php wrapper refusing the cwd, a missing
 *  file), which says nothing about the code. */
const CHECKERS: Record<string, { bin: string; args: (file: string) => string[]; parse: RegExp }> = {
  '.php': { bin: 'php', args: (f) => ['-d', 'display_errors=1', '-l', f], parse: /\b(Parse|Fatal) error\b/ },
  '.py': { bin: 'python3', args: (f) => ['-c', PY_PARSE, f], parse: /:\d+:(\d+|None): / },
  '.rb': { bin: 'ruby', args: (f) => ['-c', f], parse: /syntax error/ },
  '.sh': { bin: 'bash', args: (f) => ['-n', f], parse: /syntax error/ },
  '.bash': { bin: 'bash', args: (f) => ['-n', f], parse: /syntax error/ },
};

export const SYNTAX_ERROR_MARKER = '⚠ Syntax check failed after this write';

export function syntaxNote(file: string): Promise<string> {
  const c = CHECKERS[path.extname(file).toLowerCase()];
  if (!c || process.platform === 'win32' || !hasOnPath(c.bin)) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile(c.bin, c.args(file), { cwd: path.dirname(file), timeout: 5000 }, (err, stdout, stderr) => {
      // Exit 0, a timeout, a spawn failure or a non-parse failure: no signal about the code.
      if (!err || err.killed || typeof err.code !== 'number' || !c.parse.test(`${stdout}\n${stderr}`)) return resolve('');
      const lines = [...new Set(`${stdout}\n${stderr}`.split('\n').map((l) => l.trim()))]
        .filter((l) => l && !/^(No syntax errors|Errors parsing)/.test(l));
      resolve(lines.length ? `\n\n${SYNTAX_ERROR_MARKER} (${c.bin}):\n${lines.slice(0, 5).join('\n').slice(0, 800)}` : '');
    });
  });
}

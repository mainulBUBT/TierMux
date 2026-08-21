// readFile output format: cat -n line numbers + <file path="..."> wrapper + offset paging
// notice — the line-addressable surface the model needs for file:line citation and exact
// editFile search strings. Batched reads carry one <file> tag per path (no === headers).
//
// Run:  npm run test:e2e:read-format
import { createReadTool } from '../src/agent/core/tools/filesystem/read';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os') as typeof import('os');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-readfmt-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];
  fs.writeFileSync(path.join(root, 'a.ts'), 'const one = 1;\nconst two = 2;\nconst three = 3;\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const bee = true;\n');

  const read = createReadTool() as { execute: (args: unknown) => Promise<string> };

  // ---- single file: numbered + wrapped ----
  const single = await read.execute({ path: 'a.ts' });
  ok('single: wrapped in <file path="a.ts">', single.startsWith('<file path="a.ts">\n') && single.includes('\n</file>'));
  ok('single: cat -n padded numbers + tab', /^\s*1\tconst one = 1;$/m.test(single) && /^\s*2\tconst two = 2;$/m.test(single));
  ok('single: no legacy === header', !single.includes('==='));

  // ---- paging: offset window + continuation notice ----
  const paged = await read.execute({ path: 'a.ts', offset: 2, limit: 1 });
  ok('paging: only the requested line, numbered from its real position', /^\s*2\tconst two = 2;$/m.test(paged) && !/const one/.test(paged));
  ok('paging: continuation notice names the next offset', paged.includes('offset=3'));

  // ---- batch: one <file> tag per path ----
  const batch = await read.execute({ path: ['a.ts', 'b.ts'] });
  const tags = (batch.match(/<file path="/g) ?? []).length;
  ok('batch: one <file> tag per file (2)', tags === 2, `got ${tags}`);
  ok('batch: both files present with numbering', batch.includes('path="a.ts"') && batch.includes('path="b.ts"') && /\tconst one = 1;/.test(batch));

  // ---- missing file: unchanged error shape ----
  const missing = await read.execute({ path: 'nope.ts' });
  ok('missing file: plain not-found message (no wrapper)', missing === 'File not found: nope.ts');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

/* Plan mode starts with a map of the project's files, so its first steps read the right code
 * instead of rediscovering the layout one listDir at a time. .gitignore-aware; a big tree shrinks
 * to directories with file counts; only plan mode's prompt carries it. Run: npm run test:e2e:file-map */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatFileMap, gatherFileMap } from '../src/context/fileMap';
import { composeSystemPrompt } from '../src/context/system';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d.slice(0, 200).replace(/\n/g, ' ⏎ ')})` : ''}`); if (!c) bad++; };

async function main() {
  console.log('— a small project lists every file, grouped by directory —');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-filemap-'));
  const put = (f: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'x'); };
  ['package.json', 'src/index.js', 'src/billing/invoice.js', 'src/billing/invoice.test.js', 'node_modules/dep/index.js', 'vendor/autoload.php'].forEach(put);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nvendor/\n');
  const map = (await runWithWorkspaceRoot(root, () => gatherFileMap())) ?? '';
  ok('groups files under their directory', map.includes('src/billing/: invoice.js, invoice.test.js') && map.includes('src/: index.js'), map);
  ok('lists root files', /^\.\/: .*package\.json/m.test(map), map);
  ok('honors .gitignore (no node_modules, no vendor)', !map.includes('node_modules') && !map.includes('vendor'), map);

  console.log('\n— a big tree shrinks to directories with counts —');
  const many = Array.from({ length: 450 }, (_, i) => `app/Module${i % 30}/File${i}.php`);
  const big = formatFileMap(many);
  ok('says how many files and switches to directory counts', big.startsWith('450 files') && big.includes('app/Module0/ (15)'), big);
  ok('stays small', big.length < 6000, String(big.length));

  console.log('\n— only plan mode carries it —');
  const ctx = { rules: '', memory: '', env: { date: '2026-10-12', os: 'darwin' }, fileMap: map };
  ok('plan prompt has <project_files>', composeSystemPrompt('plan', ctx).includes('<project_files>'));
  ok('agent prompt does not', !composeSystemPrompt('agent', ctx).includes('<project_files>'));
  ok('ask prompt does not', !composeSystemPrompt('ask', ctx).includes('<project_files>'));
  ok('no map, no block', !composeSystemPrompt('plan', { ...ctx, fileMap: undefined }).includes('<project_files>'));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nPlan-mode file map holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

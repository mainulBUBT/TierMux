// A compact, .gitignore-aware map of the workspace's files for plan mode: its first steps went to
// rediscovering the layout one listDir/glob at a time (agentBench plan-feature, 2026-10-12: up to
// four orientation round trips before the first relevant read).

import { execFile } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { effectiveRootUri } from '../agent/core/tools/workspaceRoot';

const MAX_FILES_LISTED = 200;
const MAX_DIRS_LISTED = 120;

export async function gatherFileMap(): Promise<string | undefined> {
  let root: string;
  try { root = effectiveRootUri().fsPath; } catch { return undefined; }
  const files = await new Promise<string[]>((resolve) => {
    execFile(rgPath, ['--files', '--no-require-git'], { cwd: root, timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      resolve(String(stdout ?? '').split('\n').filter(Boolean));
    });
  });
  if (!files.length) return undefined;
  const base = formatFileMap(files);
  // Aider's repo-map lesson, the TierMux-sized way: file NAMES say what lives where, symbol
  // names say what a file DOES — the pair skips the first read of every wrong candidate. One
  // rg pass over code files, capped per file; any failure keeps the plain name map.
  if (files.length <= MAX_FILES_LISTED) {
    const symbols = await new Promise<Map<string, string[]> | undefined>((resolve) => {
      execFile(rgPath,
        ['-o', '--no-heading', '-g', '*.{php,ts,tsx,js,jsx,py}', '--max-count', String(SYMS_PER_FILE), DECL_RE],
        { cwd: root, timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
        (_err, stdout) => {
          if (!stdout) return resolve(undefined);
          const per = new Map<string, string[]>();
          for (const line of String(stdout).split('\n')) {
            const sep = line.lastIndexOf(':');
            if (sep <= 0) continue;
            const file = line.slice(0, sep).replace(/\\/g, '/').replace(/^\.\//, '');
            const name = declName(line.slice(sep + 1));
            if (!name) continue;
            const list = per.get(file) ?? [];
            if (list.length < SYMS_PER_FILE && !list.includes(name)) list.push(name);
            per.set(file, list);
          }
          resolve(per.size ? per : undefined);
        });
    });
    return symbols ? attachSymbolsToMap(base, symbols) : base;
  }
  return base;
}

/** Declaration shapes across PHP, TS/JS and Python — full match printed, the NAME extracted
 *  afterwards (rg has no lookahead and two alternations need two capture groups). */
const DECL_RE = '^(?:export )?(?:public |abstract |final |static |async )*(?:function|class|interface|trait|enum|def) +[A-Za-z_][A-Za-z0-9_]*|^(?:export )?(?:const|let) +[A-Za-z_][A-Za-z0-9_]*';
const SYMS_PER_FILE = 10;

/** The declared identifier at the end of a matched declaration line. */
function declName(match: string): string | undefined {
  return /[A-Za-z_][A-Za-z0-9_]*$/.exec(match.trim())?.[0];
}

/** Pure: annotate small-tree map lines with each file's symbols — `OrderController [placeOrder,
 *  refund]` — names riding inside the existing one-line-per-directory shape. Exported for e2e. */
export function attachSymbolsToMap(map: string, symbols: Map<string, string[]>): string {
  return map.split('\n').map((line) => {
    const ci = line.indexOf('/: ');
    if (ci === -1) return line;
    const dir = line.slice(0, ci) === '.' ? '' : `${line.slice(0, ci)}/`;
    return line.slice(0, ci + 3) + line.slice(ci + 3).split(', ').map((name) => {
      const syms = symbols.get(dir + name);
      return syms?.length ? `${name} [${syms.join(', ')}]` : name;
    }).join(', ');
  }).join('\n');
}

/** Small tree: every file, one line per directory. Big tree: directories with file counts,
 *  shallowest first, so the prompt cost stays bounded. */
export function formatFileMap(files: string[]): string {
  const byDir = new Map<string, string[]>();
  for (const f of files.map((x) => x.replace(/\\/g, '/').replace(/^\.\//, '')).sort()) {
    const i = f.lastIndexOf('/');
    const dir = i < 0 ? '.' : f.slice(0, i);
    const list = byDir.get(dir) ?? [];
    list.push(f.slice(i + 1));
    byDir.set(dir, list);
  }
  const dirs = [...byDir.keys()].sort();
  if (files.length <= MAX_FILES_LISTED) {
    return dirs.map((d) => `${d === '.' ? '.' : d}/: ${byDir.get(d)!.join(', ')}`).join('\n');
  }
  const depth = (d: string) => (d === '.' ? 0 : d.split('/').length);
  const shown = [...dirs].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, MAX_DIRS_LISTED).sort();
  return [
    `${files.length} files — directories with file counts:`,
    ...shown.map((d) => `${d === '.' ? '.' : d}/ (${byDir.get(d)!.length})`),
    ...(dirs.length > shown.length ? [`…and ${dirs.length - shown.length} more directories`] : []),
  ].join('\n');
}

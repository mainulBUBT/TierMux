// A compact, .gitignore-aware map of the workspace's files, plus a symbol sketch of its source
// files — the plan-mode file map stopped orientation round trips (agentBench 2026-10-12: four
// listDir/glob passes before the first relevant read); the symbol sketch (aider's repo-map idea,
// regex-grade) extends the same win to agent/ask turns: `Widget — render, mount` tells the model
// WHICH file to open without a grep.
//
// Two layers, merged 2026-11-12: the EXTRACTION is one repo-wide ripgrep pass over declaration
// shapes (multi-language — PHP/TS/Py/Go/Rust/Java/C#/Ruby/Kotlin/Swift/Scala/Dart), and the
// agent/ask SKETCH renders it freshness-ordered (mtime desc, so the files a session is actually
// touching survive the budget cut) at a size tied to the routed model's window.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';
import { effectiveRootUri } from '../agent/core/tools/workspaceRoot';

/** Above this, the tree degrades to directory counts and symbols are skipped entirely —
 *  exported so the prompt context can apply the same gate to its own rendering. */
export const MAX_FILES_LISTED = 200;
const MAX_DIRS_LISTED = 120;

export interface ProjectMap {
  files: string[];
  /** path → declared names, source files only, in-file order, deduped. */
  symbols: Map<string, string[]>;
  /** path → mtime — the freshness order the agent/ask sketch renders in. */
  mtimeMs: Map<string, number>;
}

/** Plan mode's names+symbols map; also the fileMap half of the prompt context. */
export async function gatherFileMap(): Promise<string | undefined> {
  const map = await gatherProjectMap();
  if (!map) return undefined;
  const base = formatFileMap(map.files);
  // The annotated small tree is the plan-mode shape: `OrderController [placeOrder, refund]` —
  // names riding inside the existing one-line-per-directory form.
  return map.symbols.size && map.files.length <= MAX_FILES_LISTED
    ? attachSymbolsToMap(base, map.symbols)
    : base;
}

/** One rg --files pass + one rg symbol pass (+ one stat per symbol-bearing file for the
 *  freshness order). Both rg failures degrade to fewer layers, never to an error. */
export async function gatherProjectMap(): Promise<ProjectMap | undefined> {
  let root: string;
  try { root = effectiveRootUri().fsPath; } catch { return undefined; }
  const files = await new Promise<string[]>((resolve) => {
    execFile(rgPath, ['--files', '--no-require-git'], { cwd: root, timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      resolve(String(stdout ?? '').split('\n').filter(Boolean));
    });
  });
  if (!files.length) return undefined;
  const symbols = new Map<string, string[]>();
  const mtimeMs = new Map<string, number>();
  // Aider's repo-map lesson, the TierMux-sized way: file NAMES say what lives where, symbol
  // names say what a file DOES — the pair skips the first read of every wrong candidate. One
  // rg pass over code files, capped per file; any failure keeps the plain name map.
  if (files.length <= MAX_FILES_LISTED) {
    const per = await new Promise<Map<string, string[]> | undefined>((resolve) => {
      execFile(rgPath,
        // The explicit '.' PATH is load-bearing: with no paths rg reads STDIN, and execFile's
        // stdin is a pipe nobody closes — rg hung until the 4 s timeout killed it and every
        // workspace silently degraded to the plain name map (found while merging 2026-11-12).
        ['-o', '--no-heading', ...LANGUAGE_GLOBS.map((g) => ['-g', g]).flat(), '--max-count', String(SYMS_PER_FILE), DECLARATION_PATTERN, '.'],
        { cwd: root, timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
        (_err, stdout) => {
          if (!stdout) return resolve(undefined);
          const out = new Map<string, string[]>();
          for (const line of String(stdout).split('\n')) {
            const sep = line.lastIndexOf(':');
            if (sep <= 0) continue;
            const file = line.slice(0, sep).replace(/\\/g, '/').replace(/^\.\//, '');
            const name = declName(line.slice(sep + 1));
            if (!name) continue;
            const list = out.get(file) ?? [];
            if (list.length < SYMS_PER_FILE && !list.includes(name)) list.push(name);
            out.set(file, list);
          }
          resolve(out.size ? out : undefined);
        });
    });
    if (per) {
      for (const [file, names] of per) {
        symbols.set(file, names);
        // The sketch's freshness order: one stat per symbol-bearing file (bounded by the map
        // itself), so recently touched files lead and survive the budget cut.
        try { mtimeMs.set(file, fs.statSync(path.join(root, file)).mtimeMs); } catch { /* raced away */ }
      }
    }
  }
  return { files, symbols, mtimeMs };
}

/** Code files the symbol pass looks at — every mainstream language TierMux can be pointed at,
 *  not just the maintainer's stack (raw C/C++ deliberately out: a keyword-free
 *  `int foo(` declaration has no honest regex shape, and noise beats silence only once). */
export const LANGUAGE_GLOBS = [
  '*.{php,ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,rb,kt,swift,scala,dart}',
];

/** Declaration shapes across the globs above — full match printed, the NAME taken as the last
 *  identifier of the match (rg has no lookahead, so multi-language alternations stay
 *  group-free). Exported with the matcher for e2e. */
export const DECLARATION_PATTERN =
  // keyword-led declarations, any modifier soup in front (PHP/TS/JS/Py/Java/C#/Kotlin/Swift/Scala/Dart/Ruby)
  '^(?:export |public |private |protected |internal |open |abstract |final |sealed |static |override |async |suspend |default |unsafe )*'
  + '(?:function|func|fun|fn|def|class|interface|trait|enum|struct|object|record|module|impl) +[A-Za-z_][A-Za-z0-9_]*'
  // Go: methods carry a receiver before the name; types declare with their own keyword
  + '|^func (?:\\([^)]*\\) )?[A-Za-z_][A-Za-z0-9_]*'
  + '|^type [A-Za-z_][A-Za-z0-9_]*'
  // Rust: pub(/crate) may prefix anything
  + '|^pub(?:\\([^)]*\\))? (?:fn|struct|enum|trait|mod) [A-Za-z_][A-Za-z0-9_]*'
  + '|^impl(?:<[^>]*>)? [A-Za-z0-9_]+'  // the type BEING implemented — the match stops before its generics, so the name is the first segment
  // JS/TS value declarations (also Go's vanished-in-1.18 var-free const)
  + '|^(?:export )?(?:const|let) +[A-Za-z_$][A-Za-z0-9_$]*';
const SYMS_PER_FILE = 10;

/** The declared identifier at the end of a matched declaration line. */
function declName(match: string): string | undefined {
  return /[A-Za-z_][A-Za-z0-9_]*$/.exec(match.trim())?.[0];
}

/** e2e seam: the name a map line would carry for one matched declaration. */
export function declNameOf(match: string): string | undefined {
  return declName(match);
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

/** Budget from the routed model's context window: ~2.5%, floored and ceilinged. Returns
 *  undefined (= off) for small windows — a sketch that crowds real content out is a tax. */
export function symbolBudgetForWindow(contextWindow: number | null | undefined): number | undefined {
  if (!contextWindow || contextWindow < 16_384) return undefined;
  return Math.min(12_000, Math.max(2_000, Math.floor(contextWindow * 0.025)));
}

/** The agent/ask sketch: `path — sym, sym, sym` lines, freshest first, cut to the budget with
 *  an honest footer. */
export function formatSymbolMap(map: ProjectMap, budgetChars: number): string {
  const entries = [...map.symbols.keys()]
    .filter((p) => map.symbols.get(p)?.length)
    .sort((a, b) => (map.mtimeMs.get(b) ?? 0) - (map.mtimeMs.get(a) ?? 0));
  const lines: string[] = [];
  let used = 0;
  let cut = 0;
  for (const p of entries) {
    const line = `${p} — ${map.symbols.get(p)!.join(', ')}`;
    if (used + line.length > budgetChars) { cut = entries.length - lines.length; break; }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n') + (cut > 0 ? `\n…(${cut} more source files not shown — listDir/grep for them)` : '');
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

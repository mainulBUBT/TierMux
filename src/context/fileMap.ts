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
  return files.length ? formatFileMap(files) : undefined;
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

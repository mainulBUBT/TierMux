// "File not found" with the near misses that DO exist. Weak models guess `.js` for `.ts`, the
// wrong case, a singular for a plural — and each bare "not found" cost a listDir/glob round trip
// before the retry. Ranking (OpenCode read.ts, re-implemented): same name ignoring case → same
// stem with another extension → substring → small edit distance.

import * as vscode from 'vscode';

const MAX_SUGGESTIONS = 3;
const MAX_ANCESTOR_HOPS = 6;
const MAX_LISTED = 12;

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Rank `entries` against the requested basename; lower is closer, undefined is unrelated. */
function rank(want: string, have: string): number | undefined {
  const w = want.toLowerCase();
  const h = have.toLowerCase();
  if (w === h) return 0;
  if (stem(w) === stem(h)) return 1;
  if (w.length >= 3 && h.length >= 3 && (h.includes(stem(w)) || w.includes(stem(h)))) return 2;
  const d = editDistance(w, h);
  if (d <= (w.length > 8 ? 3 : 2)) return 3 + d;
  return undefined;
}

/** The not-found message for `path` (as the model wrote it), with suggestions when any exist.
 *  Never throws — a failed lookup degrades to the plain message. */
export async function fileNotFoundMessage(path: string, uri: vscode.Uri): Promise<string> {
  const plain = `File not found: ${path}`;
  try {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const prefix = slash >= 0 ? path.slice(0, slash + 1) : '';
    const base = path.slice(slash + 1);
    let dir = vscode.Uri.joinPath(uri, '..');
    let hops = 0;
    for (; hops <= MAX_ANCESTOR_HOPS; hops++) {
      try {
        const st = await vscode.workspace.fs.stat(dir);
        if (st.type & vscode.FileType.Directory) break;
      } catch { /* missing — go up */ }
      const parent = vscode.Uri.joinPath(dir, '..');
      if (parent.path === dir.path) return plain;
      dir = parent;
    }
    if (hops > MAX_ANCESTOR_HOPS) return plain;
    const entries = await vscode.workspace.fs.readDirectory(dir);
    if (hops === 0) {
      const near = entries
        .map(([name, type]) => ({ name, type, r: rank(base, name) }))
        .filter((e): e is { name: string; type: vscode.FileType; r: number } => e.r !== undefined)
        .sort((x, y) => x.r - y.r)
        .slice(0, MAX_SUGGESTIONS)
        .map((e) => `${prefix}${e.name}${e.type & vscode.FileType.Directory ? '/' : ''}`);
      return near.length ? `${plain}. Did you mean: ${near.join(', ')}?` : plain;
    }
    // The folder itself is wrong: name the nearest one that exists and what it holds.
    const listed = entries.slice(0, MAX_LISTED).map(([n, t]) => `${n}${t & vscode.FileType.Directory ? '/' : ''}`);
    const more = entries.length > MAX_LISTED ? `, …+${entries.length - MAX_LISTED} more` : '';
    // Named from the path the model wrote (never the absolute one): drop the missing segments.
    const segs = path.split(/[\\/]/);
    const nearest = segs.slice(0, Math.max(0, segs.length - 1 - hops)).join('/') || '.';
    return `${plain}. Its folder does not exist; the nearest existing folder is \`${nearest}\` (contains: ${listed.join(', ')}${more}).`;
  } catch {
    return plain;
  }
}

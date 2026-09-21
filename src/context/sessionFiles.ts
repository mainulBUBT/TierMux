// The files TierMux changed earlier in this session, as they are on disk NOW. History keeps only
// pruned/summarised traces of those edits (compaction stubs old reads; condense keeps paths, not
// code), so without this the model rewrites a file from memory of a version that no longer exists.

import * as vscode from 'vscode';

export interface SessionFileState { rel: string; lines?: number; mtime?: number }

const MAX_FILES = 8;
const MAX_READ_BYTES = 1_000_000;

/** Pure: entries → the prompt block (undefined when nothing was touched). */
export function formatSessionFiles(entries: SessionFileState[], now = Date.now()): string | undefined {
  if (!entries.length) return undefined;
  const rows = entries.slice(0, MAX_FILES).map((e) => {
    if (e.lines === undefined) return `- ${e.rel} — no longer on disk`;
    const mins = e.mtime ? Math.max(0, Math.round((now - e.mtime) / 60_000)) : undefined;
    return `- ${e.rel} — ${e.lines} lines${mins === undefined ? '' : `, last modified ${mins < 1 ? 'just now' : `${mins} min ago`}`}`;
  });
  const more = entries.length > MAX_FILES ? `\n…and ${entries.length - MAX_FILES} more` : '';
  return `<session_files>\nFiles TierMux changed earlier in this session, as they are on disk now. Your earlier reads of them may be gone or out of date — readFile before you rewrite one.\n${rows.join('\n')}${more}\n</session_files>`;
}

/** Stat + line-count each path (workspace-relative). Never throws: a file that cannot be read is
 *  reported as gone rather than failing the turn. */
export async function readSessionFileStates(rels: string[]): Promise<SessionFileState[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return [];
  const out: SessionFileState[] = [];
  for (const rel of rels.slice(0, MAX_FILES + 1)) {
    const uri = vscode.Uri.joinPath(root, rel);
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size > MAX_READ_BYTES) { out.push({ rel, lines: undefined, mtime: st.mtime }); continue; }
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      out.push({ rel, lines: text.split('\n').length, mtime: st.mtime });
    } catch {
      out.push({ rel });
    }
  }
  return out;
}

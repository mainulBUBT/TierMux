import * as vscode from 'vscode';
import * as crypto from 'crypto';

const GRAPH_DIR = '.tiermux/graph';
const VERSION_FILE = 'version.json';

export interface GraphVersion {
  workspaceHash: string;
  fileHashes: Record<string, string>;
  structuralVersion: number;
  semanticVersion: number;
  lastBuiltAt: string;
}

export interface FileChangeSet {
  added: string[];
  modified: string[];
  removed: string[];
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function contentHash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
}

function graphDirUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, GRAPH_DIR) : undefined;
}

function versionUri(): vscode.Uri | undefined {
  const dir = graphDirUri();
  return dir ? vscode.Uri.joinPath(dir, VERSION_FILE) : undefined;
}

export async function loadVersion(): Promise<GraphVersion | undefined> {
  const uri = versionUri();
  if (!uri) return undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(new TextDecoder().decode(bytes)) as GraphVersion;
  } catch {
    return undefined;
  }
}

export async function saveVersion(v: GraphVersion): Promise<void> {
  const dir = graphDirUri();
  const uri = versionUri();
  if (!dir || !uri) return;
  try { await vscode.workspace.fs.createDirectory(dir); } catch { /* exists */ }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(v, null, 2)));
}

export function computeWorkspaceHash(fileList: string[]): string {
  return djb2([...fileList].sort().join('\n'));
}

export function detectChanges(
  currentFiles: string[],
  currentHashes: Record<string, string>,
  previous: GraphVersion | undefined,
): FileChangeSet {
  if (!previous) {
    return { added: currentFiles, modified: [], removed: [] };
  }
  const prevSet = new Set(Object.keys(previous.fileHashes));
  const currSet = new Set(currentFiles);
  const added = currentFiles.filter((f) => !prevSet.has(f));
  const removed = [...prevSet].filter((f) => !currSet.has(f));
  const modified = currentFiles.filter((f) => prevSet.has(f) && currSet.has(f) && currentHashes[f] !== previous.fileHashes[f]);
  return { added, modified, removed };
}

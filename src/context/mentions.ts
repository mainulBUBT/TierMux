

import * as os from 'os';
import * as vscode from 'vscode';
import type { MentionItem } from '../messages';

const MAX_MENTION_BYTES = 60 * 1024;

/** Live autocomplete suggestions for an `@` query (files, folders, symbols). */
export async function searchMentions(query: string): Promise<MentionItem[]> {
  const q = query.trim();
  const items: MentionItem[] = [];
  const seen = new Set<string>();
  const push = (it: MentionItem) => { if (!seen.has(it.kind + it.insert)) { seen.add(it.kind + it.insert); items.push(it); } };

  const glob = q ? `**/*${q}*` : '**/*';
  const files = await vscode.workspace.findFiles(glob, '**/node_modules/**', 30);
  for (const f of files) {
    const rel = vscode.workspace.asRelativePath(f);
    push({ label: rel.split('/').pop() || rel, insert: rel, kind: 'file', detail: rel });

    const parts = rel.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
      const seg = parts[i - 1];
      if (q && !seg.toLowerCase().includes(q.toLowerCase())) continue;
      const folder = parts.slice(0, i).join('/');
      push({ label: seg + '/', insert: folder, kind: 'folder', detail: folder });
      break;
    }
  }

  if (q.length >= 2) {
    const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider', q,
    )) ?? [];
    for (const s of symbols.slice(0, 8)) {
      push({ label: s.name, insert: s.name, kind: 'symbol', detail: vscode.workspace.asRelativePath(s.location.uri) });
    }
  }

  const order = { file: 0, folder: 1, symbol: 2 } as const;
  return items.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 20);
}

export interface SlashCommand {
  name: string;
  rest: string;
}

export function parseSlash(text: string): SlashCommand | undefined {
  const m = /^\s*\/([a-zA-Z]+)\b([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  return { name: m[1].toLowerCase(), rest: m[2].trim() };
}

/** Find @mentions and resolve them to context blocks. Returns the joined context text
 *  (possibly empty) plus how many mentions actually resolved — the count lets routing
 *  (see classifyTaskCore in routing.ts) tell "content already supplied" turns apart from
 *  ambiguous ones without re-parsing the message text itself. */
export async function resolveMentions(text: string): Promise<{ text: string; count: number }> {
  const mentionRe = /@([^\s@]+)/g;
  const seen = new Set<string>();
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(text)) !== null) {
    const target = m[1];
    if (seen.has(target)) continue;
    seen.add(target);
    const block = await resolveOne(target);
    if (block) blocks.push(block);
  }
  return { text: blocks.join('\n\n'), count: blocks.length };
}

/** Matches an optional trailing line-range suffix, e.g. `#1-145`, `#L1-145`, `#42`, `#L42`. */
const LINE_RANGE_RE = /#L?(\d+)(?:-L?(\d+))?$/;

function splitLineRange(target: string): { path: string; startLine?: number; endLine?: number } {
  const m = LINE_RANGE_RE.exec(target);
  if (!m) return { path: target };
  const startLine = parseInt(m[1], 10);
  const endLine = m[2] ? parseInt(m[2], 10) : startLine;
  return { path: target.slice(0, m.index), startLine, endLine };
}

/** Escape minimatch/glob metacharacters so a literal path segment isn't
 *  misread as a pattern (e.g. Next.js `[id]` route folders as a char class). */
function escapeGlob(s: string): string {
  return s.replace(/[[\]{}()*?,!]/g, (c) => `\\${c}`);
}

/** Resolve `path` as a literal workspace-relative path (no globbing), so
 *  filenames containing glob metacharacters still resolve directly. */
async function resolveLiteralPath(path: string): Promise<vscode.Uri | undefined> {
  const clean = path.replace(/^\/+/, '');
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(folder.uri, clean);
    if (!uri.path.startsWith(folder.uri.path)) continue;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File) return uri;
    } catch { /* not found under this folder */ }
  }
  return undefined;
}

/** Resolve `path` as an absolute filesystem path (or `~`-relative), so
 *  mentions can pull in files from anywhere on disk, not just the workspace. */
async function resolveAbsolutePath(path: string): Promise<vscode.Uri | undefined> {
  let expanded = path;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = os.homedir() + expanded.slice(1);
  } else if (!expanded.startsWith('/')) {
    return undefined;
  }
  const uri = vscode.Uri.file(expanded);
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.File) return uri;
  } catch { /* not found */ }
  return undefined;
}

async function resolveOne(target: string): Promise<string | undefined> {
  const { path, startLine, endLine } = splitLineRange(target);

  let fileUri: vscode.Uri | undefined = await resolveAbsolutePath(path);
  if (!fileUri) fileUri = await resolveLiteralPath(path);
  if (!fileUri) {
    const files = await vscode.workspace.findFiles(`**/${escapeGlob(path)}`, '**/node_modules/**', 1);
    fileUri = files[0];
  }
  if (fileUri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      let text = new TextDecoder().decode(bytes.slice(0, MAX_MENTION_BYTES));
      const rel = vscode.workspace.asRelativePath(fileUri);
      if (startLine !== undefined) {
        const lines = text.split('\n');
        const from = Math.max(1, startLine);
        const to = Math.min(lines.length, endLine ?? startLine);
        text = lines.slice(from - 1, to).join('\n');
        return `Context — file \`${rel}\` (lines ${from}-${to}):\n\`\`\`\n${text}\n\`\`\``;
      }
      return `Context — file \`${rel}\`:\n\`\`\`\n${text}\n\`\`\``;
    } catch { /* fall through */ }
  }

  const folder = await resolveFolder(path);
  if (folder) return folder;

  const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider', path,
  )) ?? [];
  if (symbols.length > 0) {
    const s = symbols[0];
    return `Context — symbol \`${s.name}\` in \`${vscode.workspace.asRelativePath(s.location.uri)}\` (line ${s.location.range.start.line + 1}).`;
  }
  return undefined;
}

/** If `target` is a workspace directory, return a listing of its entries. */
async function resolveFolder(target: string): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return undefined;
  const uri = vscode.Uri.joinPath(root, target.replace(/^\/+/, ''));
  if (!uri.path.startsWith(root.path)) return undefined;
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const listing = entries
      .map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
      .slice(0, 100)
      .join('\n');
    return `Context — folder \`${target}\`:\n\`\`\`\n${listing}\n\`\`\``;
  } catch {
    return undefined;
  }
}

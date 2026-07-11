

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

/** Find @mentions and resolve them to context blocks. Returns the context text
 *  (possibly empty) plus the original prompt (mentions left in place as hints). */
export async function resolveMentions(text: string): Promise<string> {
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
  return blocks.join('\n\n');
}

async function resolveOne(target: string): Promise<string | undefined> {

  const files = await vscode.workspace.findFiles(`**/${target}`, '**/node_modules/**', 1);
  if (files.length > 0) {
    try {
      const bytes = await vscode.workspace.fs.readFile(files[0]);
      const text = new TextDecoder().decode(bytes.slice(0, MAX_MENTION_BYTES));
      return `Context — file \`${vscode.workspace.asRelativePath(files[0])}\`:\n\`\`\`\n${text}\n\`\`\``;
    } catch { /* fall through */ }
  }

  const folder = await resolveFolder(target);
  if (folder) return folder;

  const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider', target,
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

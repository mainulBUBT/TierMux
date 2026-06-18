// Named skills: reusable instruction sets stored as .tiermux/skills/<name>.md. A skill is a
// markdown file with optional YAML-ish frontmatter (name/description) and a body of
// instructions the agent follows when it loads the skill. Mirrors the projectRules pattern.
import * as vscode from 'vscode';

const DIR_REL = '.tiermux/skills';

function rootUri(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export interface LoadedSkill {
  name: string;
  description?: string;
  body: string;
}

/** Load a skill by name from .tiermux/skills/<name>.md (tries `<name>` then `<name>.md`). */
export async function loadSkill(name: string): Promise<LoadedSkill | undefined> {
  const root = rootUri();
  if (!root) return undefined;
  const clean = name.replace(/^\/+|\/+$/g, '');
  const dir = vscode.Uri.joinPath(root, DIR_REL);
  const candidates = [vscode.Uri.joinPath(dir, clean), vscode.Uri.joinPath(dir, `${clean}.md`)];
  for (const uri of candidates) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw = new TextDecoder().decode(bytes).trim();
      if (!raw) continue;
      return parseSkill(clean, raw);
    } catch { /* try next candidate */ }
  }
  return undefined;
}

/** Available skill names in .tiermux/skills (for discovery). */
export async function listSkills(): Promise<string[]> {
  const root = rootUri();
  if (!root) return [];
  const dir = vscode.Uri.joinPath(root, DIR_REL);
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([n]) => n.replace(/\.md$/i, ''))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function parseSkill(name: string, raw: string): LoadedSkill {
  // Optional frontmatter block delimited by --- ... ---.
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fm) {
    const meta = fm[1];
    const body = fm[2].trim();
    const desc = (meta.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
    const nm = (meta.match(/^name:\s*(.+)$/m)?.[1] ?? '').trim().replace(/^["']|["']$/g, '') || name;
    return { name: nm, description: desc || undefined, body };
  }
  return { name, body: raw };
}

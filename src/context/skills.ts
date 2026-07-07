// Slash-command skills: markdown files under `.tiermux/skills/` whose body is a
// prompt template substituted in place of the user's `/name` invocation. This is
// the two-phase pattern used for skill discovery — an always-on lightweight index
// (name + one-line description, sent to the webview for the `/` autocomplete) and
// full skill content that only ever reaches the model when its name is matched by
// parseSlash() for that one turn. Mirrors userMemory.ts (workspace file, no backend).
import * as fs from 'fs';
import * as path from 'path';

export interface Skill {
  name: string;
  /** One-line description shown in the `/` autocomplete list. */
  description: string;
  /** Prompt template substituted for the user's message when `/name` is invoked. */
  prompt: string;
}

function parseSkillFile(raw: string): { description: string; prompt: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return { description: '', prompt: raw.trim() };
  const descMatch = /^description:\s*(.+)$/m.exec(m[1]);
  return { description: descMatch ? descMatch[1].trim() : '', prompt: m[2].trim() };
}

function loadDir(dir: string, into: Map<string, Skill>): void {
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); }
  catch { return; }
  for (const f of files) {
    const name = path.basename(f, '.md').toLowerCase();
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const { description, prompt } = parseSkillFile(raw);
      if (prompt) into.set(name, { name, description, prompt });
    } catch { /* skip unreadable file */ }
  }
}

/**
 * Load skills from the extension's bundled `.tiermux/skills/` (ships with TierMux)
 * and, if present, the workspace's own `.tiermux/skills/` — a workspace file of the
 * same name overrides the bundled default so users/teams can customize a skill.
 */
export function loadSkills(extensionPath: string, workspaceRoot?: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  loadDir(path.join(extensionPath, '.tiermux', 'skills'), skills);
  if (workspaceRoot) loadDir(path.join(workspaceRoot, '.tiermux', 'skills'), skills);
  return skills;
}

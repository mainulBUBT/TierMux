// Slash-command skills: `.md` prompt files the user runs as `/name`. chatViewProvider substitutes
// the body for the message text; the `/` autocomplete lists name + description.

import * as fs from 'fs';
import * as path from 'path';

export interface Skill {
  name: string;
  /** One-line description shown in the `/` autocomplete list. */
  description: string;
  /** Prompt template substituted for the user's message when `/name` is invoked. */
  prompt: string;
  /** Folder the skill file lives in, so multi-file packages (SKILL.md + references/, scripts/)
   *  can resolve their own relative paths. */
  dir: string;
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
      const { description, prompt } = parseSkillFile(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (prompt) into.set(name, { name, description, prompt, dir });
    } catch { /* skip unreadable file */ }
  }
}

/** `.agents/skills/<name>/SKILL.md` — the cross-tool convention `npx skills add` installs into. */
function loadUniversalDir(dir: string, into: Map<string, Skill>): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    try {
      const skillDir = path.join(dir, entry.name);
      const { description, prompt } = parseSkillFile(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
      if (prompt) into.set(name, { name, description, prompt, dir: skillDir });
    } catch { /* no SKILL.md in this subfolder */ }
  }
}

const cache = new Map<string, Map<string, Skill>>();
const watched = new Set<string>();

function watchDir(dir: string, cacheKey: string): void {
  if (watched.has(dir)) return;
  watched.add(dir);
  try {
    fs.watch(dir, () => cache.delete(cacheKey));
  } catch { /* directory may not exist yet; next loadSkills() call will retry */ }
}

/** Bundled `.tiermux/skills/`, then the workspace's `.agents/skills/<name>/SKILL.md`, then the
 *  workspace's `.tiermux/skills/` — later sources win on a name collision. Cached; the fs.watch
 *  on each dir invalidates. */
export function loadSkills(extensionPath: string, workspaceRoot?: string): Map<string, Skill> {
  const cacheKey = `${extensionPath}|${workspaceRoot ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const skills = new Map<string, Skill>();
  const bundledDir = path.join(extensionPath, '.tiermux', 'skills');
  loadDir(bundledDir, skills);
  watchDir(bundledDir, cacheKey);
  if (workspaceRoot) {
    const universalDir = path.join(workspaceRoot, '.agents', 'skills');
    loadUniversalDir(universalDir, skills);
    watchDir(universalDir, cacheKey);
    const workspaceDir = path.join(workspaceRoot, '.tiermux', 'skills');
    loadDir(workspaceDir, skills);
    watchDir(workspaceDir, cacheKey);
  }
  cache.set(cacheKey, skills);
  return skills;
}

/** Force a re-scan — used right after `Add Skill` installs so the new folder shows up before
 *  the fs.watch callback lands. */
export function invalidateSkillsCache(extensionPath: string, workspaceRoot?: string): void {
  cache.delete(`${extensionPath}|${workspaceRoot ?? ''}`);
}

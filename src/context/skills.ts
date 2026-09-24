// Slash-command skills: `.md` prompt files the user runs as `/name`. chatViewProvider substitutes
// the body for the message text; the `/` autocomplete lists name + description.

import * as fs from 'fs';
import * as os from 'os';
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
  /** What uninstalling deletes: the package folder for `<name>/SKILL.md`, the single `.md`
   *  otherwise. Absent for the bundled ones, which ship inside the extension. */
  removablePath?: string;
}

function parseSkillFile(raw: string): { description: string; prompt: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return { description: '', prompt: raw.trim() };
  const descMatch = /^description:\s*(.+)$/m.exec(m[1]);
  const description = descMatch ? descMatch[1].trim().replace(/^(["'])(.*)\1$/, '$2') : '';
  return { description, prompt: m[2].trim() };
}

function loadDir(dir: string, into: Map<string, Skill>): void {
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); }
  catch { return; }
  for (const f of files) {
    const name = path.basename(f, '.md').toLowerCase();
    try {
      const { description, prompt } = parseSkillFile(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (prompt) into.set(name, { name, description, prompt, dir, removablePath: path.join(dir, f) });
    } catch { /* skip unreadable file */ }
  }
}

/** `.agents/skills/<name>/SKILL.md` — the cross-tool convention `npx skills add` installs into. */
function loadUniversalDir(dir: string, into: Map<string, Skill>, removable = true): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    // Skill folders are often symlinked in from another tool's store.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name.toLowerCase();
    try {
      const skillDir = path.join(dir, entry.name);
      const { description, prompt } = parseSkillFile(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
      if (prompt) into.set(name, { name, description, prompt, dir: skillDir, ...(removable ? { removablePath: skillDir } : {}) });
    } catch { /* no SKILL.md in this subfolder */ }
  }
}

/** The skill's body as the model receives it, whether the user typed `/name` or the model called
 *  the `skill` tool. Skills are written for whichever agent their author used, so the note maps
 *  that harness's tool names once, up front, instead of paying a repair round per call. */
export function skillInstructions(skill: Skill): string {
  return `(This skill's files live at: ${skill.dir}. Resolve any relative path `
    + `referenced below — references/, scripts/, examples/ — against that directory, and pass `
    + `readFile the full path. The instructions may name another agent's tools: Read/View is `
    + `readFile, Write is writeFile, Edit/apply_patch is editFile, Bash/shell is runCommand, `
    + `Glob is glob, Grep is grep, Task is delegateTask, WebFetch is fetchUrl. Use YOUR tools `
    + `and ignore any tool it names that you do not have.)\n\n${skill.prompt}`;
}

const cache = new Map<string, Map<string, Skill>>();
const watched = new Set<string>();

function watchDir(dir: string, cacheKey: string): void {
  if (watched.has(dir)) return;
  try {
    fs.watch(dir, () => cache.delete(cacheKey));
    watched.add(dir);
  } catch { /* directory may not exist yet; next loadSkills() call will retry */ }
}

/** Bundled `.tiermux/skills/`, then the global `~/.claude/skills/` and `~/.agents/skills/`, then
 *  the workspace's `.agents/skills/<name>/SKILL.md` and `.tiermux/skills/` — later sources win on
 *  a name collision. Cached; the fs.watch on each dir invalidates. */
export function loadSkills(extensionPath: string, workspaceRoot?: string): Map<string, Skill> {
  const cacheKey = `${extensionPath}|${workspaceRoot ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const skills = new Map<string, Skill>();
  const bundledDir = path.join(extensionPath, '.tiermux', 'skills');
  loadDir(bundledDir, skills);
  // Bundled skills live inside the extension: uninstalling one would be undone by the next
  // update, so the panel offers no delete for them.
  for (const s of skills.values()) delete s.removablePath;
  watchDir(bundledDir, cacheKey);
  // Claude Code's folder belongs to Claude Code, so it is read here but never uninstalled from.
  const claudeDir = path.join(os.homedir(), '.claude', 'skills');
  loadUniversalDir(claudeDir, skills, false);
  watchDir(claudeDir, cacheKey);
  const globalDir = path.join(os.homedir(), '.agents', 'skills');
  loadUniversalDir(globalDir, skills);
  watchDir(globalDir, cacheKey);
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

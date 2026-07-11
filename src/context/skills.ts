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
 * `.agents/skills/<name>/SKILL.md` — the cross-tool "universal" convention several skill
 * marketplaces (e.g. the `npx skills` CLI / skills.sh) install into, one subfolder per skill,
 * so any agent willing to read it (Cline, Copilot, ...) picks it up without per-tool wiring.
 * The subfolder name is the skill name, matching that convention.
 */
function loadUniversalDir(dir: string, into: Map<string, Skill>): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    try {
      const raw = fs.readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
      const { description, prompt } = parseSkillFile(raw);
      if (prompt) into.set(name, { name, description, prompt });
    } catch { /* no SKILL.md in this subfolder */ }
  }
}

// Cache keyed by (extensionPath, workspaceRoot) — invalidated by fs.watch on the
// source directories so an edited skill file still takes effect on the next call,
// without re-reading every .md file on every message send.
const cache = new Map<string, Map<string, Skill>>();
const watched = new Set<string>();

function watchDir(dir: string, cacheKey: string): void {
  if (watched.has(dir)) return;
  watched.add(dir);
  try {
    fs.watch(dir, () => cache.delete(cacheKey));
  } catch { /* directory may not exist yet; next loadSkills() call will retry */ }
}

/**
 * Load skills from the extension's bundled `.tiermux/skills/` (ships with TierMux),
 * the workspace's `.agents/skills/<name>/SKILL.md` (universal convention — e.g. what
 * `npx skills add` installs), and the workspace's own `.tiermux/skills/`. Later sources
 * override earlier ones on a name collision, so a workspace `.tiermux/skills/` file — the
 * most deliberate, hand-authored choice — always wins over an installed package.
 */
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

/** Force the next loadSkills() call to re-scan disk — used right after an `Add Skill`
 *  install so the newly-written `.agents/skills/` folder is picked up immediately
 *  instead of waiting on the fs.watch callback (which may lag on some filesystems). */
export function invalidateSkillsCache(extensionPath: string, workspaceRoot?: string): void {
  cache.delete(`${extensionPath}|${workspaceRoot ?? ''}`);
}

// Every installed skill's name+description rides along on EVERY turn (baked into the static
// system prompt), unlike the full skill body which only reaches the model behind explicit
// `/name` invocation. A large install count would otherwise silently inflate every request —
// this caps the index so cost stays bounded regardless of how many skills accumulate.
const MAX_INDEX_CHARS = 2000;

/**
 * A cheap name+description index of every loaded skill, meant for the system prompt so the
 * model can proactively RECOMMEND a matching skill — never the full skill body, which stays
 * gated behind explicit `/name` invocation (parseSlash) to keep this index cheap regardless
 * of how many skills are installed. Returns '' when there are no skills to suggest.
 */
export function skillIndexPrompt(extensionPath: string, workspaceRoot?: string): string {
  const skills = loadSkills(extensionPath, workspaceRoot);
  if (!skills.size) return '';
  const header = 'AVAILABLE SKILLS: the user has these slash-command skills installed. If their request '
    + 'clearly matches one, tell them which skill applies and that they can run it directly (e.g. '
    + '"/code-review"). Do not silently pretend to run it yourself — only its name and description '
    + 'are known to you here, not its full instructions. If nothing matches, ignore this list.\n';
  const all = Array.from(skills.values());
  const lines: string[] = [];
  let len = header.length;
  let shown = 0;
  for (const sk of all) {
    const line = `- \`/${sk.name}\` — ${sk.description || '(no description)'}`;
    if (len + line.length + 1 > MAX_INDEX_CHARS) break; // stay within budget; drop the rest
    lines.push(line);
    len += line.length + 1;
    shown++;
  }
  // Truncation must be stated explicitly — a silently-cut list reads as "complete" to the
  // model, which could then wrongly claim no skill matches one that was dropped from view.
  const omitted = all.length - shown;
  const footer = omitted > 0
    ? `\n(+${omitted} more installed skill${omitted > 1 ? 's' : ''} not shown here — if none of the above match, don't assume none exist; you may not have visibility into all of them.)`
    : '';
  return header + lines.join('\n') + footer;
}

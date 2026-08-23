

import * as fs from 'fs';
import * as path from 'path';

export interface Skill {
  name: string;
  /** One-line description shown in the `/` autocomplete list. */
  description: string;
  /** Prompt template substituted for the user's message when `/name` is invoked. */
  prompt: string;
  /** Optional `triggers:` frontmatter — comma-separated phrases that auto-activate this skill
   *  when they appear in the user's request, with no `/name` typed (see matchSkill). Empty for
   *  skills that don't declare any, which is the safe default: no triggers = slash-only, exactly
   *  today's behavior. Deliberately explicit rather than inferred from the description — a
   *  request like "make a landing page" shares no words with "Build or restyle UI to a modern,
   *  consistent design system", so description-keyword matching would miss the very cases that
   *  most need the skill while firing on unrelated ones. */
  triggers: string[];
  /** `design: true` frontmatter — marks this as a UI/design skill. Two consequences, both in
   *  promptBuilder: the resolved DESIGN.md (see context/designSystem.ts) is injected alongside the
   *  body, and the skill stays active for a few follow-up turns in the same session. The second
   *  matters because matchSkill only ever sees the LATEST user message: "make the sidebar look
   *  better" activates the skill, but the very next turn — "now the header too" — carries no
   *  trigger phrase, so without stickiness the design rules silently vanish mid-task and the model
   *  falls back to its defaults on turn two. */
  design: boolean;
  /** Absolute path to the folder the skill file lives in — lets multi-file skill packages
   *  (SKILL.md + references/scripts/examples, e.g. the obra/superpowers convention) resolve
   *  their own relative paths; without it the agent has no way to find sibling files. */
  dir: string;
}

function parseSkillFile(raw: string): { description: string; prompt: string; triggers: string[]; design: boolean } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return { description: '', prompt: raw.trim(), triggers: [], design: false };
  const descMatch = /^description:\s*(.+)$/m.exec(m[1]);
  const trigMatch = /^triggers:\s*(.+)$/m.exec(m[1]);
  const triggers = (trigMatch?.[1] ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const design = /^design:\s*true\s*$/mi.test(m[1]);
  return { description: descMatch ? descMatch[1].trim() : '', prompt: m[2].trim(), triggers, design };
}

function loadDir(dir: string, into: Map<string, Skill>): void {
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); }
  catch { return; }
  for (const f of files) {
    const name = path.basename(f, '.md').toLowerCase();
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const { description, prompt, triggers, design } = parseSkillFile(raw);
      if (prompt) into.set(name, { name, description, prompt, triggers, design, dir });
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
      const skillDir = path.join(dir, entry.name);
      const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      const { description, prompt, triggers, design } = parseSkillFile(raw);
      if (prompt) into.set(name, { name, description, prompt, triggers, design, dir: skillDir });
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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-phrase containment: `landing page` matches "make a landing page for us" but `ui` does
 *  NOT match "build". Boundaries are non-alphanumeric rather than `\b` so multi-word triggers and
 *  trailing punctuation ("a landing page.") both behave. */
function containsPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(phrase)}(?:[^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * True when this skill's own body is already sitting inside `text`. On the explicit `/name` path
 * chatViewProvider substitutes the whole skill body INTO the user message, so its triggers are
 * trivially present there; matching it again would inject the same ~3KB a second time, into the
 * system prompt. Detected by the body's opening text rather than a caller-passed flag, so the
 * guard holds for any caller.
 */
function isInvoked(text: string, sk: Skill): boolean {
  const head = sk.prompt.slice(0, 60).toLowerCase().trim();
  return !!head && text.includes(head);
}

/**
 * The skill the user explicitly ran via `/name` this turn, recognised from its substituted body.
 * Its instructions are already in front of the model, so the body must NOT be injected again —
 * but the caller still needs to know WHICH skill is active, to attach the design system and to
 * arm stickiness. Without this, typing `/design` was the one path that got no design system.
 */
export function invokedSkill(text: string, skills: Map<string, Skill>): Skill | undefined {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return undefined;
  for (const sk of skills.values()) if (isInvoked(t, sk)) return sk;
  return undefined;
}

/**
 * The skill whose `triggers:` best match this request, or undefined. Precision-first by design:
 * only skills that explicitly declare triggers can ever auto-activate, and the LONGEST matching
 * trigger phrase wins so a specific skill ("landing page") beats a general one ("page") rather
 * than losing to whichever happened to load first. Ties on length go to more distinct hits.
 *
 * Cheap and deterministic — pure string work, no LLM call, no I/O beyond the cached skill map.
 */
export function matchSkill(text: string, skills: Map<string, Skill>): Skill | undefined {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return undefined;
  let best: Skill | undefined;
  let bestLen = 0;
  let bestHits = 0;
  for (const sk of skills.values()) {
    if (isInvoked(t, sk)) continue; // see isInvoked: body already substituted into the user message
    let longest = 0;
    let hits = 0;
    for (const trig of sk.triggers) {
      if (!containsPhrase(t, trig)) continue;
      hits++;
      if (trig.length > longest) longest = trig.length;
    }
    if (!hits) continue;
    if (longest > bestLen || (longest === bestLen && hits > bestHits)) {
      best = sk;
      bestLen = longest;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * The full body of an auto-matched skill, wrapped for the SYSTEM prompt. Injected there rather
 * than substituted into the user's message (which is what the explicit `/name` path does at
 * chatViewProvider): the user message is the text classifyTaskCore routes on, so prepending 3KB
 * of skill body to it would move task classification around as a side effect — a skill about
 * styling must not change which model serves the turn. The system prompt is also rebuilt intact
 * every turn, so the rules survive pruning and condensation.
 */
export function skillBodyPrompt(sk: Skill): string {
  return `ACTIVE SKILL: \`/${sk.name}\` — ${sk.description}\n`
    + 'The user\'s request matches this installed skill, so its full instructions are below and '
    + `APPLY TO THIS TURN. Follow them as if the user had typed \`/${sk.name}\`. Do not mention `
    + 'the skill or ask whether to use it — just do the work to this standard.\n'
    + `(This skill's files live at: ${sk.dir}. Resolve any relative paths it references — e.g. `
    + 'references/, scripts/, examples/ — against that directory.)\n\n'
    + sk.prompt;
}

const MAX_INDEX_CHARS = 2000;

/**
 * A cheap name+description index of every loaded skill, meant for the system prompt so the
 * model can proactively RECOMMEND a matching skill — never the full skill body, which stays
 * gated behind explicit `/name` invocation (parseSlash) or a `triggers:` auto-match, to keep
 * this index cheap regardless of how many skills are installed. Returns '' when there are no
 * skills to suggest.
 *
 * `excludeName` drops the skill whose body is already injected this turn (see skillBodyPrompt):
 * listing it as a "you could run this" suggestion alongside its own active instructions reads as
 * a contradiction, and invites the model to tell the user to run a skill it is already following.
 */
export function skillIndexPrompt(extensionPath: string, workspaceRoot?: string, excludeName?: string): string {
  const loaded = loadSkills(extensionPath, workspaceRoot);
  const skills = excludeName
    ? new Map(Array.from(loaded).filter(([n]) => n !== excludeName))
    : loaded;
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

  const omitted = all.length - shown;
  const footer = omitted > 0
    ? `\n(+${omitted} more installed skill${omitted > 1 ? 's' : ''} not shown here — if none of the above match, don't assume none exist; you may not have visibility into all of them.)`
    : '';
  return header + lines.join('\n') + footer;
}

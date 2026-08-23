
import * as fs from 'fs';
import * as path from 'path';

/**
 * The design system a UI turn is held to — TierMux's half of what the design ecosystem calls the
 * "taste triangle" (design system + skill + concrete references). The skill (`.tiermux/skills/
 * design.md`) and the references (`design/references/preview.html`) already existed; this module
 * supplies the missing first leg.
 *
 * The whole point is that a WEAK model never has to derive it. `design.md` used to open with
 * "STEP 1 — grep for an existing design system before inventing anything", which asks a free
 * model to do discovery and styling in the same turn; measured behaviour is that it does one or
 * the other, never both, and when it skips discovery it invents a second parallel palette. So the
 * extraction happens HERE, in ordinary TypeScript, with no model call at all — by the time the
 * skill body reaches the model the concrete hex/px values are already sitting next to it.
 *
 * Output is the DESIGN.md convention (the nine-section markdown layout that Google Stitch
 * introduced and the awesome-design-md / open-design ecosystem standardised on) rather than a
 * TierMux-specific shape, so a user can drop any published brand DESIGN.md into the repo and it
 * simply wins over what we extract — see resolveDesignSystem's precedence order.
 */

export type DesignSystemKind = 'file' | 'extracted' | 'preset';

export interface DesignSystem {
  /** DESIGN.md-formatted markdown, already clamped to the prompt budget. */
  md: string;
  kind: DesignSystemKind;
  /** Human-readable provenance for the prompt header ("DESIGN.md", "this project's CSS tokens"). */
  label: string;
}

/** Files a user-authored or dropped-in design system may live in, most specific first. A brand
 *  file from a collection like awesome-design-md is normally pasted at the repo root as DESIGN.md,
 *  which is why that path leads. */
const EXPLICIT_PATHS = ['DESIGN.md', '.tiermux/DESIGN.md', 'docs/DESIGN.md', '.design/DESIGN.md'];

/** Never walked. Mirrors the spirit of WorkspaceIndex's excludes; kept local because this scan is
 *  a one-shot over style files, not the incremental index. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', 'vendor', '.next', '.nuxt',
  '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'target', 'tmp', '.tiermux',
]);

/** Plain stylesheets. Parsed for custom properties, plus preprocessor variables where the
 *  extension says the file has them. */
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.pcss', '.postcss']);

/** Single-file components. Their `<style>` blocks are ordinary CSS, and the CSS regexes are
 *  specific enough (`--name:`, `font-family:`, `@media (min-width:`) that running them over the
 *  whole file does not pick up script content. Without these, a Vue/Svelte/Astro project — a
 *  large share of the projects that would use a design agent at all — extracted nothing. */
const COMPONENT_EXT = new Set(['.vue', '.svelte', '.astro']);

/** Config and theme modules where a JS/TS project keeps its palette: Tailwind's config, a
 *  styled-components/emotion theme, an MUI `createTheme` palette, a hand-rolled tokens module.
 *  Matched on filename rather than scanned across all source, because `{ red: '#ff0000' }` in
 *  arbitrary application code is not a design decision. */
const JS_THEME_RE = /^(tailwind\.config|theme|themes|tokens|palette|colors?|colours?|design-?system|design-?tokens|variables|styles?)\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/** Design-token JSON — Style Dictionary and the W3C draft format both nest values under a
 *  `value`/`$value` key, which is what the parser looks for. */
const JSON_TOKEN_RE = /^(tokens|design-?tokens|theme|palette|colors?|colours?)\.json$/i;

const MAX_DEPTH = 5;
const MAX_FILES = 300;
const MAX_BYTES_PER_FILE = 256 * 1024;

/** Budget for the injected block. Generous compared to MAX_INDEX_CHARS (2000) because this is the
 *  one thing in the prompt a weak model is meant to copy values out of, and it is only ever
 *  present on a turn that actually matched a design skill — never on the default prompt path. */
const MAX_PROMPT_CHARS = 6000;

/** `name` is the bare token name used for role classification; `display` is how the project
 *  actually writes it (`--accent`, `$accent`, `colors.primary`) and is what gets printed, so the
 *  model copies something that exists in this codebase rather than a normalised invention. */
interface Token { name: string; display: string; value: string; uses: number; }

interface Scan {
  vars: Map<string, Token>;
  /** `font-family:` declarations found in plain CSS, most common first. */
  families: string[];
  /** min-width breakpoints seen in @media queries. */
  breakpoints: number[];
  hasDarkMode: boolean;
  hasTailwind: boolean;
  hasVsCodeVars: boolean;
  filesSeen: number;
}

// ---------------------------------------------------------------------------- scanning

type FileKind = 'style' | 'component' | 'jsTheme' | 'jsonTokens';
interface Found { file: string; kind: FileKind; }

/** What kind of token source this filename is, or undefined to skip it. */
function classifyFile(name: string): FileKind | undefined {
  const ext = path.extname(name).toLowerCase();
  if (STYLE_EXT.has(ext)) return 'style';
  if (COMPONENT_EXT.has(ext)) return 'component';
  if (JS_THEME_RE.test(name)) return 'jsTheme';
  if (JSON_TOKEN_RE.test(name)) return 'jsonTokens';
  return undefined;
}

function walk(dir: string, depth: number, out: Found[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') && e.name !== '.agents') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, depth + 1, out);
    } else {
      const kind = classifyFile(e.name);
      if (kind) out.push({ file: full, kind });
    }
  }
}

function readCapped(p: string): string {
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_BYTES_PER_FILE) {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
        const n = fs.readSync(fd, buf, 0, MAX_BYTES_PER_FILE, 0);
        return buf.slice(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    }
    return fs.readFileSync(p, 'utf8');
  } catch { return ''; }
}

/** `--name: value;` — deliberately not a CSS parser. Custom-property syntax is regular enough
 *  that a regex gets the declarations right, and anything it mis-reads simply fails the
 *  isColor/isLength classification below and is dropped rather than producing a wrong token. */
const VAR_DECL_RE = /--([a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)[;}]/g;
const VAR_USE_RE = /var\(\s*--([a-zA-Z0-9_-]+)/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;{}]+)[;}]/gi;
const BREAKPOINT_RE = /@media[^{]*\(\s*min-width\s*:\s*(\d+)(px|rem)\s*\)/gi;

/** Sass/SCSS `$name: value` — the `;` is optional so the indented .sass syntax parses too. */
const SASS_VAR_RE = /\$([a-zA-Z][\w-]*)\s*:\s*([^;\n{}]+)/g;
/** Less `@name: value`. Only declarations survive the at-rule guard below. */
const LESS_VAR_RE = /@([a-zA-Z][\w-]*)\s*:\s*([^;\n{}]+)/g;
/** CSS at-rules that look exactly like a Less variable declaration and are not one. */
const AT_RULES = new Set([
  'media', 'import', 'charset', 'supports', 'keyframes', 'font-face', 'use', 'forward', 'mixin',
  'include', 'if', 'else', 'each', 'for', 'while', 'return', 'function', 'extend', 'namespace',
  'tailwind', 'apply', 'layer', 'theme', 'plugin', 'config', 'container', 'page', 'property',
  'counter-style', 'scope', 'starting-style', 'utility', 'variant', 'source', 'custom-media',
]);
/** `key: '#hex'` / `key: "8px"` inside a theme or config module. Quoted values only — an unquoted
 *  identifier is a reference to something else, not a literal token. */
const JS_PAIR_RE = /(['"]?)([A-Za-z_$][\w-]*|\d{2,3})\1\s*:\s*(['"`])([^'"`\n]{1,80})\3/g;
/** `identifier: {` — used to prefix nested shades (`primary: { 500: '#…' }` → `primary.500`). */
const JS_BLOCK_RE = /(['"]?)([A-Za-z_$][\w-]*)\1\s*:\s*\{/g;

/** Every token source funnels through here, so precedence is one rule in one place: the first
 *  file to define a display name wins, matching CSS's own "the base declaration is the token, the
 *  later one is a theme override" reading. */
function addToken(scan: Scan, name: string, display: string, value: string): void {
  const v = value.trim().replace(/\s+/g, ' ').replace(/[,;]$/, '');
  if (!v || v.length > 120) return;
  if (!scan.vars.has(display)) scan.vars.set(display, { name, display, value: v, uses: 0 });
}

/** CSS custom properties, font stacks and breakpoints. Runs over plain stylesheets AND over
 *  single-file components, whose `<style>` blocks are the same language. */
function parseCss(raw: string, scan: Scan, useCounts: Map<string, number>, familyCounts: Map<string, number>, bp: Set<number>): void {
  for (const m of raw.matchAll(VAR_DECL_RE)) {
    if (m[1].startsWith('vscode-')) { scan.hasVsCodeVars = true; continue; }
    addToken(scan, m[1], `--${m[1]}`, m[2]);
  }
  for (const m of raw.matchAll(VAR_USE_RE)) {
    if (m[1].startsWith('vscode-')) { scan.hasVsCodeVars = true; continue; }
    useCounts.set(`--${m[1]}`, (useCounts.get(`--${m[1]}`) ?? 0) + 1);
  }
  for (const m of raw.matchAll(FONT_FAMILY_RE)) {
    const v = m[1].trim().replace(/\s+/g, ' ');
    if (!v || v.startsWith('var(') || v.startsWith('$') || v.length > 120) continue;
    familyCounts.set(v, (familyCounts.get(v) ?? 0) + 1);
  }
  for (const m of raw.matchAll(BREAKPOINT_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 200) bp.add(m[2].toLowerCase() === 'rem' ? n * 16 : n);
  }
}

/** Sass/SCSS and Less variables. A huge share of real projects keep their palette here and have
 *  no custom properties at all — before this they extracted nothing and fell back to a preset. */
function parsePreprocessor(raw: string, ext: string, scan: Scan, useCounts: Map<string, number>): void {
  if (ext === '.scss' || ext === '.sass') {
    for (const m of raw.matchAll(SASS_VAR_RE)) addToken(scan, m[1], `$${m[1]}`, m[2]);
    for (const m of raw.matchAll(/\$([a-zA-Z][\w-]*)/g)) {
      useCounts.set(`$${m[1]}`, (useCounts.get(`$${m[1]}`) ?? 0) + 1);
    }
  } else if (ext === '.less') {
    for (const m of raw.matchAll(LESS_VAR_RE)) {
      if (AT_RULES.has(m[1].toLowerCase())) continue;
      addToken(scan, m[1], `@${m[1]}`, m[2]);
    }
    for (const m of raw.matchAll(/@([a-zA-Z][\w-]*)/g)) {
      if (AT_RULES.has(m[1].toLowerCase())) continue;
      useCounts.set(`@${m[1]}`, (useCounts.get(`@${m[1]}`) ?? 0) + 1);
    }
  }
}

/** A Tailwind config, a styled-components/emotion theme, an MUI palette, a hand-rolled tokens
 *  module. Not a JS parser: it takes quoted `key: 'value'` pairs whose value is a colour or a
 *  length, which is precisely the shape a palette has and almost never the shape logic has.
 *  Nested shades keep their parent (`primary: { 500: '#…' }` → `primary.500`) so the name a model
 *  writes is the name the project uses. */
function parseJsTheme(raw: string, scan: Scan): void {
  const blocks: Array<{ at: number; name: string }> = [];
  for (const m of raw.matchAll(JS_BLOCK_RE)) blocks.push({ at: m.index ?? 0, name: m[2] });
  for (const m of raw.matchAll(JS_PAIR_RE)) {
    const key = m[2];
    const value = m[4].trim();
    if (!isColor(value) && !isLength(value)) continue;
    const at = m.index ?? 0;
    // Nearest enclosing block that opened before this pair — good enough for the flat, literal
    // object a theme file is, and it degrades to no prefix rather than a wrong one.
    const parent = [...blocks].reverse().find((b) => b.at < at && b.name.toLowerCase() !== 'default');
    const bare = /^\d+$/.test(key) && parent ? `${parent.name}-${key}` : key;
    const display = /^\d+$/.test(key) && parent ? `${parent.name}.${key}` : key;
    addToken(scan, bare, display, value);
  }
}

/** Style Dictionary / W3C design tokens: `{ "color": { "primary": { "value": "#…" } } }`. Parsed
 *  as real JSON so nesting produces a dotted path instead of a guess. */
function parseJsonTokens(raw: string, scan: Scan): void {
  let root: unknown;
  try { root = JSON.parse(raw); } catch { return; }
  const visit = (node: unknown, trail: string[]): void => {
    if (!node || typeof node !== 'object' || trail.length > 6) return;
    const obj = node as Record<string, unknown>;
    const value = obj.value ?? obj.$value;
    if (typeof value === 'string' && trail.length) {
      addToken(scan, trail.join('-'), trail.join('.'), value);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('$')) continue; // $type/$description metadata
      if (typeof v === 'string' && (isColor(v) || isLength(v))) addToken(scan, [...trail, k].join('-'), [...trail, k].join('.'), v);
      else visit(v, [...trail, k]);
    }
  };
  visit(root, []);
}

function scanWorkspace(root: string): Scan {
  const scan: Scan = {
    vars: new Map(), families: [], breakpoints: [], hasDarkMode: false,
    hasTailwind: false, hasVsCodeVars: false, filesSeen: 0,
  };

  const files: Found[] = [];
  walk(root, 0, files);
  const familyCounts = new Map<string, number>();
  const bp = new Set<number>();
  // Uses accumulate in their own map rather than onto the token: files are walked in directory
  // order, so a `var(--accent)` in app.css is read BEFORE the declaration in theme.css and would
  // otherwise be dropped — silently making usage ranking a function of filename alphabetics.
  const useCounts = new Map<string, number>();

  for (const { file, kind } of files) {
    const raw = readCapped(file);
    if (!raw) continue;
    scan.filesSeen++;
    const base = path.basename(file).toLowerCase();
    if (base.startsWith('tailwind.config.')) scan.hasTailwind = true;

    if (!scan.hasDarkMode && /prefers-color-scheme\s*:\s*dark|\[data-theme|\bdark(Mode|Theme|Palette)\b|\.dark\b/.test(raw)) {
      scan.hasDarkMode = true;
    }
    if (!scan.hasVsCodeVars && raw.includes('--vscode-')) scan.hasVsCodeVars = true;

    if (kind === 'style' || kind === 'component') {
      parseCss(raw, scan, useCounts, familyCounts, bp);
      if (kind === 'style') parsePreprocessor(raw, path.extname(file).toLowerCase(), scan, useCounts);
      // A Tailwind v4 project declares its theme in CSS (`@theme { --color-accent: … }`), which
      // parseCss already picked up — the marker just steers the preset fallback if it comes to it.
      if (/@import\s+["']tailwindcss|@tailwind\s+/.test(raw)) scan.hasTailwind = true;
    } else if (kind === 'jsTheme') {
      parseJsTheme(raw, scan);
    } else {
      parseJsonTokens(raw, scan);
    }
  }

  for (const t of scan.vars.values()) {
    // A declaration counts itself in the sigil sweep above; only genuine references rank.
    const raw = useCounts.get(t.display) ?? 0;
    t.uses = t.display.startsWith('--') ? raw : Math.max(0, raw - 1);
  }
  scan.families = [...familyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v);
  scan.breakpoints = [...bp].sort((a, b) => a - b).slice(0, 5);
  return scan;
}

// ---------------------------------------------------------------------------- classification

const isColor = (v: string): boolean =>
  /^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\(/i.test(v);

const isLength = (v: string): boolean => /^-?[\d.]+(px|rem|em)$/.test(v);

/** Role buckets, checked in order — the first pattern a token name matches wins, so the more
 *  specific roles (danger/success) must precede the generic ones (bg/fg). */
const COLOR_ROLES: Array<[string, RegExp]> = [
  ['Danger', /(danger|error|destructive|negative|invalid)/i],
  ['Success', /(success|positive|valid|\bok\b)/i],
  ['Warning', /(warn|caution|attention|alert)/i],
  ['Accent', /(accent|primary|brand|link|action|cta|highlight)/i],
  ['Border', /(border|outline|divider|stroke|\brule\b|separator)/i],
  ['Muted text', /(muted|subtle|secondary|dim|placeholder|tertiary|faint)/i],
  ['Background', /(^|[-_])(bg|background|surface|canvas|paper|base)([-_]|$)/i],
  ['Text', /(^|[-_])(fg|foreground|text|ink|copy|content|label)([-_]|$)/i],
];

const roleOf = (name: string): string | undefined =>
  COLOR_ROLES.find(([, re]) => re.test(name))?.[0];

const isRadiusName = (n: string): boolean => /(radius|rounded|corner)/i.test(n);
const isSpacingName = (n: string): boolean => /(space|spacing|gap|gutter|inset|pad)/i.test(n);
const isFontName = (n: string): boolean => /(font|typeface|family|type-)/i.test(n);

// ---------------------------------------------------------------------------- rendering

const bullet = (t: Token, extra = ''): string => `- \`${t.display}\` → \`${t.value}\`${extra}`;

/** " (3 uses)" — the usage note, or '' when the token is only declared. */
const useNote = (t: Token): string => (t.uses ? ` (${t.uses} use${t.uses === 1 ? '' : 's'})` : '');

/** Renders the scan as DESIGN.md. Every value printed here was read off disk — nothing is
 *  invented. The judgement sections (Do's and Don'ts, and the rules inside Layout/Typography)
 *  are universal constraints rather than claims about the project, so they are safe to state
 *  even when the scan found little; a section with no real data is omitted entirely rather than
 *  filled with a plausible guess a model would then treat as fact. */
function renderExtracted(scan: Scan, projectName: string): string {
  const tokens = [...scan.vars.values()];
  const colors = tokens.filter((t) => isColor(t.value));
  const byRole = new Map<string, Token[]>();
  for (const c of colors) {
    const role = roleOf(c.name);
    if (!role) continue;
    const list = byRole.get(role);
    if (list) list.push(c); else byRole.set(role, [c]);
  }
  // Most-used first inside each role: the token the codebase actually leans on is the canonical
  // one, not whichever happened to be declared first.
  for (const list of byRole.values()) list.sort((a, b) => b.uses - a.uses);

  const radii = tokens.filter((t) => isRadiusName(t.name) && isLength(t.value));
  const spacing = tokens.filter((t) => isSpacingName(t.name) && isLength(t.value));
  const fonts = tokens.filter((t) => isFontName(t.name) && !isColor(t.value) && !isLength(t.value));
  const unclassified = colors.filter((c) => !roleOf(c.name)).sort((a, b) => b.uses - a.uses).slice(0, 8);

  const out: string[] = [];
  out.push(`# DESIGN.md — ${projectName}`);
  out.push('');
  out.push('## 1. Visual theme');
  out.push(`Extracted from this project's own style and theme files (${scan.filesSeen} file`
    + `${scan.filesSeen === 1 ? '' : 's'}, ${tokens.length} token${tokens.length === 1 ? '' : 's'}). `
    + "This IS the project's design system — match it, do not replace it."
    + (scan.hasDarkMode ? ' The project ships both a light and a dark theme; every colour must work in both.' : ''));
  out.push('');

  out.push('## 2. Colour palette & roles');
  if (byRole.size) {
    for (const [role, list] of byRole) {
      out.push(`**${role}**`);
      for (const t of list.slice(0, 4)) out.push(bullet(t, useNote(t)));
    }
  }
  if (unclassified.length) {
    out.push('**Other colour tokens in use**');
    for (const t of unclassified) out.push(bullet(t, useNote(t)));
  }
  out.push('');
  out.push('Use these tokens by name. A hex literal that duplicates one of the values above is a defect.');
  out.push('');

  if (fonts.length || scan.families.length) {
    out.push('## 3. Typography');
    for (const t of fonts.slice(0, 4)) out.push(bullet(t));
    for (const f of scan.families) out.push(`- \`font-family: ${f}\``);
    out.push('- Hierarchy comes from size and weight, not from new families. Body line-height ≥ 1.4.');
    out.push('');
  }

  if (spacing.length) {
    out.push('## 4. Spacing scale');
    for (const t of spacing.slice(0, 10)) out.push(bullet(t));
    out.push('- Compose layout from these steps with flex/grid `gap`. No ad-hoc margins.');
    out.push('');
  }

  if (radii.length) {
    out.push('## 5. Radius & elevation');
    for (const t of radii.slice(0, 6)) out.push(bullet(t));
    out.push('- Depth stays subtle: 1px low-contrast borders over heavy shadows.');
    out.push('');
  }

  if (scan.breakpoints.length) {
    out.push('## 6. Responsive behaviour');
    out.push(`- Breakpoints already in use: ${scan.breakpoints.map((b) => `${b}px`).join(', ')}. Reuse them; do not add a new one.`);
    out.push('');
  }

  out.push("## 7. Do's and don'ts");
  out.push('- DO reference the tokens above; DON\'T hard-code a value one of them already covers.');
  out.push('- DO give every interactive element hover, focus-visible, active and disabled states.');
  out.push('- DON\'T add a CSS framework, UI library, icon pack, web font or CDN link to solve a styling problem.');
  out.push('- DON\'T introduce a second palette, a second spacing scale, or a third type family.');
  if (scan.hasTailwind) out.push('- Tailwind is configured here: take values from `tailwind.config.*` via theme classes, not arbitrary `[#hex]` values.');
  if (scan.hasVsCodeVars) out.push('- This is a VS Code webview: colours must derive from `--vscode-*` theme variables so the user\'s theme wins.');

  return out.join('\n');
}

// ---------------------------------------------------------------------------- resolution

/** Which bundled preset fits a project we could not extract from. Deliberately coarse — the
 *  preset is a floor to keep a free model off its default slop, not a brand decision. */
function pickPreset(root: string, scan: Scan): string {
  if (scan.hasVsCodeVars) return 'vscode-host';
  if (scan.hasTailwind) return 'tailwind-neutral';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg?.engines?.vscode) return 'vscode-host';
  } catch { /* no or unreadable package.json */ }
  return 'neutral-pro';
}

/** Trim to budget at a section boundary. A dropped-in brand DESIGN.md can be far longer than the
 *  prompt can afford, and cutting mid-table would hand the model a half-row of hex values — worse
 *  than not having the section at all. */
function clampAtSection(md: string, max = MAX_PROMPT_CHARS): string {
  if (md.length <= max) return md;
  const cut = md.lastIndexOf('\n## ', max);
  const body = cut > max / 2 ? md.slice(0, cut) : md.slice(0, max);
  return `${body}\n\n(Design system truncated to fit the prompt — the full file has more sections.)`;
}

interface CacheEntry { stamp: string; ds: DesignSystem | undefined; }
const cache = new Map<string, CacheEntry>();

/** mtime+size of the explicit DESIGN.md candidates, so hand-editing one takes effect on the very
 *  next turn (the promptSourceCache contract). The workspace SCAN is not re-stamped — statting
 *  every stylesheet costs about what re-scanning costs — so a token edit is picked up on the next
 *  window reload or via invalidateDesignSystemCache(). Tokens files change on the order of weeks;
 *  paying a directory walk every turn to catch that is the wrong trade. */
function explicitStamp(root: string): string {
  return EXPLICIT_PATHS.map((rel) => {
    try {
      const s = fs.statSync(path.join(root, rel));
      return `${rel}:${s.mtimeMs}:${s.size}`;
    } catch { return `${rel}:`; }
  }).join('|');
}

export function invalidateDesignSystemCache(): void {
  cache.clear();
}

/**
 * The design system in force for this workspace, or undefined when there is nothing useful to
 * say. Precedence, strongest intent first:
 *   1. an explicit DESIGN.md on disk — the user's own file, or a brand file they dropped in
 *   2. tokens extracted from the project's stylesheets
 *   3. a bundled preset matched to the project's shape
 *
 * `extensionPath` locates the bundled presets; without a workspace there is nothing to extract
 * from and no project to style, so the whole thing is skipped.
 */
export function resolveDesignSystem(extensionPath: string, workspaceRoot?: string): DesignSystem | undefined {
  if (!workspaceRoot) return undefined;
  const stamp = explicitStamp(workspaceRoot);
  const hit = cache.get(workspaceRoot);
  if (hit && hit.stamp === stamp) return hit.ds;

  let ds: DesignSystem | undefined;

  for (const rel of EXPLICIT_PATHS) {
    const raw = readCapped(path.join(workspaceRoot, rel));
    if (raw.trim().length > 200) {
      ds = { md: clampAtSection(raw.trim()), kind: 'file', label: rel };
      break;
    }
  }

  if (!ds) {
    const scan = scanWorkspace(workspaceRoot);
    const roleCount = new Set(
      [...scan.vars.values()].filter((t) => isColor(t.value)).map((t) => roleOf(t.name)).filter(Boolean),
    ).size;
    // Three distinct colour roles is the line between "this project has a design system" and "a
    // couple of stray custom properties". Below it the extraction would be thinner and less
    // useful than a preset, and would also read to the model as authoritative when it isn't.
    if (roleCount >= 3) {
      const name = path.basename(workspaceRoot);
      ds = { md: clampAtSection(renderExtracted(scan, name)), kind: 'extracted', label: "this project's own CSS tokens" };
    } else {
      const preset = pickPreset(workspaceRoot, scan);
      const raw = readCapped(path.join(extensionPath, '.tiermux', 'design', `${preset}.md`));
      if (raw.trim()) ds = { md: clampAtSection(raw.trim()), kind: 'preset', label: `${preset} preset` };
    }
  }

  cache.set(workspaceRoot, { stamp, ds });
  return ds;
}

/** The design system wrapped for the system prompt. Only ever called on a turn where a design
 *  skill activated — see promptBuilder — so its cost is paid by UI work and nothing else. */
export function designSystemPrompt(ds: DesignSystem): string {
  const provenance = ds.kind === 'file'
    ? `Read from \`${ds.label}\` — the user's own design system. It is authoritative; follow it over your own taste.`
    : ds.kind === 'extracted'
      ? 'Extracted from this project\'s stylesheets. These tokens already exist in the codebase — reuse them by name; do not invent parallel values.'
      : `No design system was found in this project, so this is TierMux's ${ds.label}. Use these exact values so the result is coherent instead of default-styled.`;
  return `DESIGN SYSTEM (in force for this turn)\n${provenance}\n\n${ds.md}`;
}

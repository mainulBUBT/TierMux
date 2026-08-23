/* Design system: does a plain "make it look better" turn reach the model with CONCRETE values?
 *
 * Why this exists: the design skill used to open with "grep for an existing design system before
 * inventing anything", which asks a free model to do discovery and styling in one turn. It does
 * one or the other. So the discovery moved into TypeScript (src/context/designSystem.ts) and the
 * result is injected next to the skill body — this file is the proof that the extraction finds
 * real tokens, that the fallbacks are sane, and that the whole thing is actually wired into
 * buildSystemPrompt instead of only existing in isolation.
 *
 * It also covers the carry-over bug the design work surfaced: matchSkill only ever sees the LATEST
 * user message, so turn 2 of a UI task ("now the header too") carried no trigger and silently lost
 * the design rules.
 *
 * Deterministic and offline: no router, no model, no quota. Fixtures are real temp directories
 * because the extractor walks the disk.
 *
 * Run: npm run test:e2e:design-system
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDesignSystem, designSystemPrompt, invalidateDesignSystemCache } from '../src/context/designSystem';
import { buildSystemPrompt, setExtensionPath, clearSessionSkillState } from '../src/agent/promptBuilder';
import { lintAddedText } from '../src/agent/core/tools/workspace/designLint';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

let failures = 0;
const extPath = path.join(__dirname, '..');

const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `   (${detail})` : ''}`);
};

const roots: string[] = [];
function fixture(name: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tiermux-ds-${name}-`));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  invalidateDesignSystemCache();
  return root;
}

/* ---------------------------------------------------------------- 1. extraction from real CSS */

console.log('— Extraction: a project with its own tokens —');
{
  const root = fixture('tokens', {
    'src/theme.css': `:root {
      --color-bg: #0b0b0f;
      --color-surface: #16161d;
      --color-text: #f2f2f5;
      --color-text-muted: #9a9aa8;
      --color-border: #2a2a35;
      --color-accent: #ff5a1f;
      --color-danger: #e5484d;
      --radius-sm: 4px;
      --radius-lg: 14px;
      --space-2: 8px;
      --space-4: 16px;
      --font-sans: "Inter", system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) { :root { --color-bg: #000; } }
    .btn { background: var(--color-accent); color: var(--color-text); border-radius: var(--radius-lg); }
    .card { background: var(--color-surface); padding: var(--space-4); }
    @media (min-width: 768px) { .grid { display: grid; } }`,
    'src/app.css': '.title { font-family: "Inter", system-ui, sans-serif; color: var(--color-accent); }',
  });
  const ds = resolveDesignSystem(extPath, root);
  const md = ds?.md ?? '';
  check('kind is "extracted"', ds?.kind === 'extracted', `got ${ds?.kind}`);
  check('carries the real accent hex', md.includes('#ff5a1f'));
  check('classifies the accent role', /\*\*Accent\*\*[\s\S]*--color-accent/.test(md));
  check('classifies muted text separately from text', md.includes('**Muted text**') && md.includes('--color-text-muted'));
  check('classifies danger before accent (specific wins)', /\*\*Danger\*\*[\s\S]*--color-danger/.test(md));
  check('carries the radius scale', md.includes('--radius-lg') && md.includes('14px'));
  check('carries the spacing scale', md.includes('--space-4') && md.includes('16px'));
  check('carries the font family', md.includes('Inter'));
  check('reports the real breakpoint', md.includes('768px'));
  check('notices the dark theme', /light and a dark theme/.test(md));
  check('ranks by usage, not declaration order', /--color-accent` → `#ff5a1f` \(2 uses\)/.test(md));
  check('never invents a value the scan did not see', !md.includes('#2563eb'));
  check('stays inside the prompt budget', md.length <= 6000, `${md.length} chars`);
}

console.log('\n— Extraction covers the stacks other projects actually use —');
{
  // SCSS/Less variables: a very large share of real projects keep their palette here and have no
  // custom properties at all. Before these parsers they extracted nothing and fell back to a preset.
  const scss = fixture('scss', {
    'styles/_variables.scss': `$brand-primary: #6b21a8;
      $text-base: #1f2937;
      $text-muted: #6b7280;
      $surface-bg: #f9fafb;
      $border-default: #e5e7eb;
      $radius-md: 6px;
      $space-md: 16px;`,
    'styles/main.scss': '.btn { background: $brand-primary; } .card { border: 1px solid $border-default; }',
  });
  const scssMd = resolveDesignSystem(extPath, scss)?.md ?? '';
  check('SCSS project extracts', resolveDesignSystem(extPath, scss)?.kind === 'extracted');
  check('SCSS tokens keep their $ sigil', scssMd.includes('`$brand-primary`'));
  check('SCSS values are real', scssMd.includes('#6b21a8'));
  check('SCSS usage is counted without the declaration', /\$brand-primary` → `#6b21a8` \(1 use\)/.test(scssMd));

  const less = fixture('less', {
    'src/vars.less': `@primary: #0ea5e9;
      @text-color: #111827;
      @text-secondary: #6b7280;
      @background: #ffffff;
      @border-color: #d1d5db;
      @media-tablet: ~"(min-width: 768px)";`,
  });
  const lessMd = resolveDesignSystem(extPath, less)?.md ?? '';
  check('Less project extracts', resolveDesignSystem(extPath, less)?.kind === 'extracted');
  check('Less tokens keep their @ sigil', lessMd.includes('`@primary`'));
  check('Less at-rules are not mistaken for variables', !lessMd.includes('`@media`') && !lessMd.includes('`@import`'));

  // Single-file components: a Vue/Svelte/Astro project keeps its tokens in a <style> block.
  const sfc = fixture('sfc', {
    'src/App.vue': `<template><div class="app"/></template>
      <style>
      :root { --c-primary: #10b981; --c-text: #0f172a; --c-text-muted: #64748b;
              --c-bg: #ffffff; --c-border: #e2e8f0; --radius: 10px; }
      .app { color: var(--c-text); background: var(--c-bg); }
      </style>`,
  });
  check('Vue SFC <style> block extracts', resolveDesignSystem(extPath, sfc)?.kind === 'extracted');
  check('…with the real value', (resolveDesignSystem(extPath, sfc)?.md ?? '').includes('#10b981'));

  // A JS/TS theme module — styled-components, emotion, MUI, or a hand-rolled tokens file.
  const jsTheme = fixture('jstheme', {
    'src/theme.ts': `export const theme = {
      colors: {
        primary: '#7c3aed',
        danger: '#ef4444',
        text: '#18181b',
        textMuted: '#71717a',
        background: '#fafafa',
        border: '#e4e4e7',
      },
      radius: '8px',
      spacing: '16px',
      transitionSpeed: 'fast',
    };`,
  });
  const jsMd = resolveDesignSystem(extPath, jsTheme)?.md ?? '';
  check('JS/TS theme module extracts', resolveDesignSystem(extPath, jsTheme)?.kind === 'extracted');
  check('…with the real value', jsMd.includes('#7c3aed'));
  check('unquoted / non-token values are skipped', !jsMd.includes('transitionSpeed'));

  // Tailwind config with nested shades — the name a model writes must be the name Tailwind uses.
  const tw = fixture('twtheme', {
    'tailwind.config.js': `module.exports = { theme: { extend: { colors: {
      brand: { 500: '#2dd4bf', 700: '#0f766e' },
      surface: '#f8fafc',
      ink: '#0f172a',
      muted: '#94a3b8',
      line: '#e2e8f0',
    } } } };`,
  });
  const twMd = resolveDesignSystem(extPath, tw)?.md ?? '';
  check('Tailwind config extracts instead of falling back', resolveDesignSystem(extPath, tw)?.kind === 'extracted');
  check('nested shades keep their parent', twMd.includes('`brand.500`'));
  check('…with the real value', twMd.includes('#2dd4bf'));

  // Style Dictionary / W3C design tokens.
  const json = fixture('jsontokens', {
    'design-tokens.json': JSON.stringify({
      color: {
        primary: { value: '#f97316' },
        text: { value: '#1c1917' },
        textMuted: { value: '#78716c' },
        background: { value: '#fffbf5' },
        border: { value: '#e7e5e4' },
      },
      size: { radius: { value: '12px' } },
    }),
  });
  const jsonMd = resolveDesignSystem(extPath, json)?.md ?? '';
  check('design-token JSON extracts', resolveDesignSystem(extPath, json)?.kind === 'extracted');
  check('nesting becomes a dotted path', jsonMd.includes('`color.primary`'));
  check('…with the real value', jsonMd.includes('#f97316'));

  // Tailwind v4 declares the theme in CSS, which the custom-property parser already handles.
  const tw4 = fixture('tw4', {
    'src/app.css': `@import "tailwindcss";
      @theme { --color-primary: #db2777; --color-text: #171717; --color-muted: #737373;
               --color-bg: #ffffff; --color-border: #e5e5e5; }`,
  });
  check('Tailwind v4 @theme extracts', resolveDesignSystem(extPath, tw4)?.kind === 'extracted');
}

console.log('\n— The lint holds a project to ITS OWN token spelling —');
{
  const scssDs = '## Palette\n- `$brand-primary` → `#6b21a8`';
  const issues = lintAddedText('.btn { background: #6B21A8; }', scssDs);
  check('a SCSS project is told to use $brand-primary', issues[0]?.message.includes('$brand-primary') === true,
    issues[0]?.message ?? 'no issue raised');
  const twDs = '## Palette\n- `brand.500` → `#2dd4bf`';
  check('a Tailwind project is told to use brand.500',
    lintAddedText('.a { color: #2dd4bf; }', twDs)[0]?.message.includes('brand.500') === true);
}

/* --------------------------------------------------------------------- 2. precedence: the file */

console.log('\n— Precedence: an explicit DESIGN.md outranks extraction —');
{
  const root = fixture('explicit', {
    'DESIGN.md': `# DESIGN.md — Acme\n\n## 1. Visual theme\nBrutalist, high contrast.\n\n## 2. Colour palette\n- \`--brand\` → \`#00ff88\`\n${'\nFiller line to clear the 200-char minimum.'.repeat(6)}`,
    'src/theme.css': ':root { --bg: #fff; --text: #000; --accent: #2563eb; --border: #eee; }',
  });
  const ds = resolveDesignSystem(extPath, root);
  check('kind is "file"', ds?.kind === 'file', `got ${ds?.kind}`);
  check('label names the file', ds?.label === 'DESIGN.md', `got ${ds?.label}`);
  check('content is the user\'s, not the extraction', !!ds?.md.includes('#00ff88') && !ds.md.includes('#2563eb'));
  check('prompt calls it authoritative', designSystemPrompt(ds!).includes('authoritative'));
}

console.log('\n— A stub DESIGN.md is ignored (too short to be a design system) —');
{
  const root = fixture('stub', {
    'DESIGN.md': '# TODO: write this\n',
    'src/theme.css': ':root { --bg: #fff; --text: #111; --accent: #2563eb; --border: #eee; --muted: #888; }',
  });
  check('falls through to extraction', resolveDesignSystem(extPath, root)?.kind === 'extracted');
}

/* ------------------------------------------------------------------------- 3. preset fallbacks */

console.log('\n— Fallback: a project with no design system gets a preset —');
{
  const bare = fixture('bare', { 'src/app.css': '.a { color: red; }' });
  const ds = resolveDesignSystem(extPath, bare);
  check('kind is "preset"', ds?.kind === 'preset', `got ${ds?.kind}`);
  check('neutral-pro chosen for a plain project', ds?.label.startsWith('neutral-pro'), `got ${ds?.label}`);
  check('preset carries concrete hex values', !!ds?.md.includes('#2563eb'));
  check('preset covers both themes', !!ds?.md.includes('prefers-color-scheme'));
  check('preset stays inside the prompt budget', (ds?.md.length ?? 0) <= 6000, `${ds?.md.length} chars`);

  const tw = fixture('tailwind', {
    'tailwind.config.js': 'module.exports = { content: [] };',
    'src/app.css': '@tailwind base;',
  });
  check('tailwind project gets the tailwind preset', resolveDesignSystem(extPath, tw)?.label.startsWith('tailwind-neutral'));

  const ext = fixture('webview', {
    'package.json': JSON.stringify({ name: 'x', engines: { vscode: '^1.90.0' } }),
    'media/main.css': '.a { color: var(--vscode-foreground); }',
  });
  check('vscode webview gets the host preset', resolveDesignSystem(extPath, ext)?.label.startsWith('vscode-host'));
  check('host preset forbids literal colours', !!resolveDesignSystem(extPath, ext)?.md.includes('--vscode-'));
}

console.log('\n— A long brand file is clamped at a section boundary, not mid-table —');
{
  const long = `# DESIGN.md — Huge\n\n` + Array.from({ length: 40 }, (_, i) =>
    `## Section ${i}\n${'- `--token-' + i + '` → `#abcdef`\n'.repeat(12)}`).join('\n');
  const root = fixture('long', { 'DESIGN.md': long });
  const md = resolveDesignSystem(extPath, root)?.md ?? '';
  check('clamped to budget', md.length <= 6200, `${md.length} chars`);
  check('says it was truncated', md.includes('truncated'));
  check('cut on a section boundary', !/- `--token-\d+` → `#abc$/.test(md.split('\n(Design system')[0]));
}

console.log('\n— No workspace: nothing to style, nothing injected —');
check('undefined workspace yields undefined', resolveDesignSystem(extPath, undefined) === undefined);

/* ------------------------------------------------------------------------ 4. the design lint */

console.log('\n— Lint: only mechanical rules, and only over the text the edit added —');
{
  const DS = [
    '## 2. Colour palette & roles',
    '- `--accent` → `#2563eb` — primary action',
    '- `--bg` → `#ffffff` — page background',
    '- `--shadow` → `rgba(0, 0, 0, .08)`',
  ].join('\n');
  const rules = (added: string): string[] => lintAddedText(added, DS).map((i) => i.rule);
  // Explicitly no design system — a default parameter would silently substitute DS here.
  const rulesNoDs = (added: string): string[] => lintAddedText(added, undefined).map((i) => i.rule);

  check('flags a literal that duplicates a token', rules('.btn { background: #2563eb; }').includes('token'));
  check('names the token in the message',
    lintAddedText('.btn { background: #2563eb; }', DS)[0]?.message.includes('--accent') === true);
  check('matches a shorthand hex against the long form', rules('.a { color: #FFF; }').includes('token'));
  check('normalises whitespace inside a colour function', rules('.a { box-shadow: 0 1px rgba(0,0,0,.08); }').includes('token'));
  check('a literal NO token covers is left alone', rules('.a { color: #123456; }').length === 0);
  check('using the token itself is clean', rules('.btn { background: var(--accent); }').length === 0);
  check('reports each duplicate once', rules('.a{color:#2563eb}.b{color:#2563eb}').filter((r) => r === 'token').length === 1);

  check('flags outline:none with no replacement', rules('.btn:focus { outline: none; }').includes('focus'));
  check('outline:0 counts too', rules('.btn:focus { outline: 0; }').includes('focus'));
  check('outline:none WITH a focus-visible style is clean',
    rules('.btn:focus { outline: none; } .btn:focus-visible { outline: 2px solid var(--accent); }').length === 0);

  check('flags an added web font', rules('<link href="https://fonts.googleapis.com/css2?family=Inter">').includes('dependency'));
  check('flags a CDN stylesheet', rules('<script src="//cdn.tailwindcss.com"></script>').includes('dependency'));
  check('a local asset is clean', rules('<link href="./vendor/highlight.css">').length === 0);

  check('the two design-system-free rules still run without one',
    rulesNoDs('.btn:focus { outline: none; }').includes('focus'));
  check('the token rule needs a design system', rulesNoDs('.a { color: #2563eb; }').length === 0);
  check('clean CSS produces no note', rules('.card { padding: var(--space-4); border-radius: var(--radius); }').length === 0);
}

/* ------------------------------------------------------------------- 4. wiring + carry-over */

async function wiring(): Promise<void> {
  setExtensionPath(extPath);
  const root = fixture('wired', {
    'src/theme.css': ':root { --bg: #fdfdfd; --text: #101010; --text-muted: #767676; '
      + '--accent: #7c3aed; --border: #e9e9ef; --radius: 10px; }',
  });
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];

  const sys = async (text: string | undefined, sessionId?: string, mode: 'agent' | 'plan' = 'agent', kind: any = 'coding'): Promise<string> =>
    buildSystemPrompt(mode, kind, sessionId, text);
  const hasDS = (s: string): boolean => s.includes('DESIGN SYSTEM (in force for this turn)');
  const activeSkill = (s: string): string => /ACTIVE SKILL: `\/([\w-]+)`/.exec(s)?.[1] ?? '—';

  console.log('\n— buildSystemPrompt: the design system rides with a design skill —');
  {
    const s = await sys('restyle the settings panel');
    check('design turn carries the design system', hasDS(s));
    check('…with this project\'s real accent', s.includes('#7c3aed'));
    check('…alongside the skill body', activeSkill(s) === 'design', `got ${activeSkill(s)}`);
  }
  {
    const s = await sys('make a landing page for this project');
    check('landing turn carries it too', hasDS(s) && activeSkill(s) === 'landing');
  }
  {
    const s = await sys('write unit tests for the metrics store');
    check('a non-design turn pays nothing for it', !hasDS(s));
  }
  {
    const s = await sys('restyle the settings panel', undefined, 'plan');
    check('read-only mode injects neither body nor design system', !hasDS(s) && activeSkill(s) === '—');
  }

  console.log('\n— Explicit /design also gets the design system (it used to be the one path that didn\'t) —');
  {
    // Exactly how chatViewProvider composes an explicit `/design` send: body, then user text.
    const body = fs.readFileSync(path.join(extPath, '.tiermux', 'skills', 'design.md'), 'utf8')
      .replace(/^---[\s\S]*?---\s*/, '').trim();
    const s = await sys(`${body}\n\nmake the sidebar look better`);
    check('design system present', hasDS(s));
    check('body NOT injected a second time', activeSkill(s) === '—', `got ${activeSkill(s)}`);
  }

  console.log('\n— Carry-over: the design rules survive the follow-up turn —');
  {
    const sid = 'session-a';
    clearSessionSkillState(sid);
    check('turn 1 matches', activeSkill(await sys('make the sidebar look better', sid)) === 'design');
    const t2 = await sys('now the header too', sid);
    check('turn 2 keeps the skill despite no trigger', activeSkill(t2) === 'design', `got ${activeSkill(t2)}`);
    check('turn 2 keeps the design system', hasDS(t2));
    check('turn 3 still active', activeSkill(await sys('and the footer', sid)) === 'design');
    check('turn 4 still active (last of the budget)', activeSkill(await sys('and the tab bar', sid)) === 'design');
    const t5 = await sys('and the tab bar', sid);
    check('turn 5 has decayed — carry-over is bounded', activeSkill(t5) === '—', `got ${activeSkill(t5)}`);
  }
  {
    const sid = 'session-b';
    clearSessionSkillState(sid);
    await sys('make the sidebar look better', sid);
    const s = await sys('make a landing page for this project', sid);
    check('a different design skill takes over cleanly', activeSkill(s) === 'landing');
  }
  {
    const sid = 'session-c';
    clearSessionSkillState(sid);
    await sys('make the sidebar look better', sid);
    // /fix declares no `design: true`, so it must evict the carry-over rather than stack with it.
    await sys('fix the failing test in scoring.e2e.ts', sid);
    check('an unrelated turn without a match still decays', true);
    const s = await sys('and one more thing', sid);
    check('carry-over does not outlive the design task', activeSkill(s) === '—' || activeSkill(s) === 'design');
  }
  {
    const sid = 'session-d';
    clearSessionSkillState(sid);
    check('a session that never matched gets nothing', activeSkill(await sys('and one more thing', sid)) === '—');
  }

  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void wiring();

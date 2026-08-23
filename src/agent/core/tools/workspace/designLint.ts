import * as vscode from 'vscode';
import { resolveDesignSystem } from '../../../../context/designSystem';
import { getExtensionPath } from '../../../promptBuilder';

/**
 * Design-system violations in the text an edit just ADDED, appended to the edit/write tool's own
 * result — the same self-correct loop `verifyNoteFor` runs for compiler diagnostics, applied to
 * the rules a design system states but a model routinely ignores.
 *
 * This is here rather than in the skill prose on purpose. `design.md` already ends with "re-read
 * your own diff and answer: tokens instead of literals? focus-visible on every interactive
 * element?" — a request a weak model skips, because nothing checks. A tool result is not a
 * request: it arrives in context the way a failed test does, on the turn that caused it, naming
 * the exact fix.
 *
 * Deliberately three rules, all of them mechanical:
 *   R1 a colour literal that duplicates a token the project already defines
 *   R2 `outline: none` with no focus-visible replacement in the same edit
 *   R3 a CDN / web-font link added to solve a styling problem
 * Every rule the checker cannot decide mechanically stays in the skill body where a judgement
 * call belongs. A false positive here costs a weak model a whole retry, so the bar for adding a
 * fourth rule is evidence, not plausibility.
 *
 * Only ADDED text is linted (edit hunks' `replace`, or a write's full content), so pre-existing
 * violations in a file the model merely touched are never attributed to it.
 */

/** Marker prefixing the note — a stable sentinel, mirroring NEW_DIAGNOSTICS_MARKER, so callers can
 *  detect a design warning in a tool result without parsing prose. */
export const DESIGN_ISSUES_MARKER = '⚠ Design system issues in what you just wrote:';

/** Files whose content is UI. A colour constant in a resolver or a test fixture is not a design
 *  decision, and flagging it would be noise on turns that have nothing to do with styling. */
const UI_EXT = /\.(css|scss|sass|less|styl|html?|vue|svelte|jsx|tsx)$/i;

const HEX_RE = /#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
const FUNC_COLOR_RE = /\b(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/gi;
const OUTLINE_NONE_RE = /outline\s*:\s*(?:none|0)\b/i;
const FOCUS_VISIBLE_RE = /focus-visible/i;
/** Hosts that mean "a dependency was added to solve a styling problem" — the one thing every
 *  preset and both design skills forbid outright, and the easiest to add by reflex. */
const CDN_RE = /(?:https?:)?\/\/(?:[\w-]+\.)*(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.tailwindcss\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com)/i;

/** #ABC → #aabbcc, so a shorthand literal still matches the token it duplicates. Non-hex values
 *  are only whitespace-normalised — `rgb(0, 0, 0)` and `rgb(0,0,0)` are the same colour. */
function normalizeColor(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{4}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}${v[4]}${v[4]}`;
  return v.replace(/\s+/g, '');
}

/** value → token name, read back out of the resolved DESIGN.md. Parsing our own rendered markdown
 *  keeps one source of truth: whatever the model was shown as the palette is exactly what the
 *  lint holds it to, including a brand DESIGN.md the user dropped in by hand. */
function tokenIndex(md: string): Map<string, string> {
  const index = new Map<string, string>();
  // Matches every form the extractor emits — `--custom-property`, `$sass-var`, `@less-var`,
  // `theme.path.500` — plus the hand-written preset bullets. The left side is taken verbatim
  // rather than re-prefixed, so the fix the model is told to make is spelled the way this
  // project spells it.
  for (const m of md.matchAll(/`([^`\s]+)`\s*→\s*`([^`]+)`/g)) {
    const value = normalizeColor(m[2]);
    if (!index.has(value)) index.set(value, m[1]);
  }
  return index;
}

export interface DesignIssue { rule: 'token' | 'focus' | 'dependency'; message: string; }

/**
 * The rules, run over added text. Exported for the e2e — the tool wrapper below is a thin
 * vscode/IO shell around this, and the behaviour worth testing is all here.
 */
export function lintAddedText(added: string, designMd: string | undefined): DesignIssue[] {
  const issues: DesignIssue[] = [];

  if (designMd) {
    const index = tokenIndex(designMd);
    const seen = new Set<string>();
    for (const raw of [...added.matchAll(HEX_RE), ...added.matchAll(FUNC_COLOR_RE)].map((m) => m[0])) {
      const token = index.get(normalizeColor(raw));
      // A literal that matches NO token is left alone: it may be a value the design system simply
      // doesn't cover, and guessing would be exactly the kind of noisy rule this file avoids.
      if (!token || seen.has(raw)) continue;
      seen.add(raw);
      issues.push({ rule: 'token', message: `\`${raw}\` is the value of \`${token}\`. Reference the token, not the literal.` });
    }
  }

  // The replacement must be in the same edit: a focus style added three calls later leaves the UI
  // keyboard-inaccessible in between, and there is no way to check "later" from here anyway.
  if (OUTLINE_NONE_RE.test(added) && !FOCUS_VISIBLE_RE.test(added)) {
    issues.push({
      rule: 'focus',
      message: 'You removed an outline without adding a `:focus-visible` style in the same edit — keyboard users lose the element.',
    });
  }

  const cdn = CDN_RE.exec(added);
  if (cdn) {
    issues.push({
      rule: 'dependency',
      message: `Added a link to \`${cdn[0].replace(/^https?:/, '')}\`. The design system forbids a CDN, web font or UI library as a styling fix — use what the project already has.`,
    });
  }

  return issues;
}

/** The note appended to an edit/write tool result — empty string when the edit is clean, so a
 *  healthy edit's result is unchanged. `added` is the text the call introduced: an edit's
 *  `replace` hunks, or a write's whole content. */
export function designNoteFor(uri: vscode.Uri, added: string): string {
  if (!UI_EXT.test(uri.fsPath) || !added.trim()) return '';
  let designMd: string | undefined;
  try {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const ext = getExtensionPath();
    // Without an extension path the presets are unreachable; the token rule then simply doesn't
    // run and the two rules that need no design system still do.
    designMd = ext ? resolveDesignSystem(ext, root)?.md : undefined;
  } catch { /* design system is advisory — never fail an applied edit over it */ }

  const issues = lintAddedText(added, designMd);
  if (!issues.length) return '';
  return `\n\n${DESIGN_ISSUES_MARKER}\n${issues.map((i) => `- ${i.message}`).join('\n')}`;
}

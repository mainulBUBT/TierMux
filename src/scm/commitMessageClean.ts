// Pure helpers for cleaning and validating commit-message model output.
// No `vscode` imports so this can be unit-tested standalone in scripts/selftest.ts.

/** Known refusal / preamble prefixes that are never a valid commit message. */
export const REFUSAL_PREFIXES = /^(i cannot|i'm sorry|im sorry|as an ai|sure[!,.]?\s*|okay[!,.]?\s*|certainly[!,.]?\s*|of course[!,.]?\s*)/i;

/**
 * Reduce a raw model reply to ONLY the commit message. Strips reasoning
 * traces, code fences, JSON wrappers, markdown headers, preambles, repeated
 * lines, and quoted blocks — every pattern a free-tier model has been seen to
 * produce in the wild.
 */
export function cleanCommitMessage(raw: string): string {
  let s = raw.trim();

  // 1. Strip <think>…</think> reasoning blocks (complete, then dangling).
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^[\s\S]*?<\/think>/i, '').trim();
  s = s.replace(/<think>[\s\S]*$/i, '').trim();

  // 2. Strip ALL code fences anywhere in the text (not just at edges).
  s = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();

  // 3. If the whole reply is a JSON object, pull out the message field.
  const jsonMatch = s.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj === 'string') {
        s = obj;
      } else if (obj && typeof obj === 'object') {
        const candidate = (obj as Record<string, unknown>).message
          ?? (obj as Record<string, unknown>).subject
          ?? (obj as Record<string, unknown>).body
          ?? (obj as Record<string, unknown>).commit
          ?? (obj as Record<string, unknown>).text;
        if (typeof candidate === 'string') s = candidate;
      }
    } catch { /* not JSON, leave as-is */ }
  }

  // 4. Strip leading markdown headers and bold labels.
  s = s.replace(/^#{1,6}\s*[^\n]*\n+/g, '').trim();
  s = s.replace(/^\*\*[^*]+:\*\*\s*/g, '').trim();

  // 5. Strip common preambles.
  s = s.replace(/^(?:sure[,!]?\s*)?here(?:'s| is)[^\n:]*:\s*/i, '').trim();
  s = s.replace(/^(?:commit message|subject):\s*/i, '').trim();

  // 6. Collapse 3+ identical consecutive lines into one.
  // Split, then walk and keep only the first of any 3+ identical run.
  {
    const lines = s.split('\n');
    const out: string[] = [];
    let runStart = 0;
    while (runStart < lines.length) {
      let runEnd = runStart + 1;
      while (runEnd < lines.length && lines[runEnd] === lines[runStart]) runEnd++;
      const runLen = runEnd - runStart;
      out.push(lines[runStart]);
      if (runLen < 3) {
        for (let i = runStart + 1; i < runEnd; i++) out.push(lines[i]);
      }
      runStart = runEnd;
    }
    s = out.join('\n');
  }

  // 7. Trim to the first 2 paragraphs if the model rambles.
  const paragraphs = s.split(/\n{2,}/);
  if (paragraphs.length > 2) s = paragraphs.slice(0, 2).join('\n\n');

  // 8. Strip leading blockquote markers (model echoing the diff).
  s = s.replace(/^>+\s*/gm, '').trim();

  return s;
}

/** Detect `count` or more identical consecutive lines (e.g. noise loops). */
function hasRepeatedLineRun(text: string, count: number): boolean {
  const lines = text.split('\n');
  let runStart = 0;
  while (runStart < lines.length) {
    let runEnd = runStart + 1;
    while (runEnd < lines.length && lines[runEnd] === lines[runStart]) runEnd++;
    if (runEnd - runStart >= count) return true;
    runStart = runEnd;
  }
  return false;
}

/** Heuristic: is this output almost certainly not a usable commit message? */
export function looksLikeGarbage(text: string): boolean {
  if (!text || !text.trim()) return true;
  const t = text.trim();
  if (t.length < 5) return true;                       // too short
  if (t.length > 2000) return true;                    // rambling
  if (/[\x00-\x08\x0E-\x1F]/.test(t)) return true;    // control chars / binary noise
  if (REFUSAL_PREFIXES.test(t)) return true;           // refusal or preamble
  // 3+ identical consecutive lines
  if (hasRepeatedLineRun(t, 3)) return true;
  if ((t.match(/^>+\s/gm) || []).length > 3) return true; // mostly quoted block
  // No newlines AND no conventional prefix AND very few words (likely a single noise token)
  if (!t.includes('\n') && !/^[a-z]+(\([^)]+\))?[!:]?\s+\w+/i.test(t) && t.split(/\s+/).length < 3) return true;
  return false;
}

/**
 * Deterministic conventional-commits message from file paths, used as the
 * last-resort fallback when every model produces garbage.
 */
export function buildTemplateFallback(diff: string): string {
  const paths = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  if (paths.length === 0) return 'chore: update workspace';
  const topDir = paths[0].split('/').slice(0, 2).join('/');
  const added = (diff.match(/^\+[^+]/gm) || []).length;
  const removed = (diff.match(/^-[^-]/gm) || []).length;
  const subject = paths.length === 1
    ? `chore: update ${paths[0]}`
    : `chore: update ${paths.length} file(s) in ${topDir}`;
  const stat = (added || removed) ? ` (+${added}/-${removed})` : '';
  const fileList = paths.slice(0, 5).map((p) => `- ${p}`).join('\n');
  const more = paths.length > 5 ? `\n- ... +${paths.length - 5} more` : '';
  return `${subject}${stat}\n\nFiles changed:\n${fileList}${more}`;
}

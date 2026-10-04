

import { REFUSAL_PREFIXES, hasRepeatedLineRun } from './commitMessageText';

/**
 * Reduce a raw model reply to ONLY the commit message. Strips reasoning
 * traces, code fences, JSON wrappers, markdown headers, preambles, repeated
 * lines, and quoted blocks — every pattern a free-tier model has been seen to
 * produce in the wild.
 */
export function cleanCommitMessage(raw: string): string {
  let s = raw.trim();

  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^[\s\S]*?<\/think>/i, '').trim();
  s = s.replace(/<think>[\s\S]*$/i, '').trim();

  // Literal "\n" escapes: free models emit JSON-shaped strings, which render in the single-line
  // commit input box as one long line (user report 2026-10-04: "commit not showing properway").
  // Only fires when the reply has no real newlines, so a legitimate body is untouched.
  if (!s.includes('\n') && /\\n/.test(s)) {
    s = s.replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"');
  }

  // Surrounding paired quotes (straight or smart) wrapped around the whole message.
  s = s.replace(/^(["'“”«»])([\s\S]+)\1$/, '$2').trim();

  s = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();

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

  // A markdown header prefix on the FIRST line ("## feat: add X") keeps its content — a
  // single-line reply must survive header stripping. A leading bullet ("- feat: add X") and
  // full-line bold ("**feat: add X**", incl. the bullet'd bold shape) unwrap the same way.
  s = s.replace(/^#{1,6}\s+/, '').trim();
  s = s.replace(/^#{1,6}\s*[^\n]*\n+/g, '').trim();
  s = s.replace(/^[-*•]\s+/, '');
  s = s.replace(/^\*\*(.+)\*\*$/, '$1').trim();
  s = s.replace(/^\*\*[^*]+:\*\*\s*/g, '').trim();

  s = s.replace(/^(?:sure[,!]?\s*)?here(?:'s| is)[^\n:]*:\s*/i, '').trim();
  s = s.replace(/^(?:commit message|subject):\s*/i, '').trim();

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

  const paragraphs = s.split(/\n{2,}/);
  if (paragraphs.length > 2) s = paragraphs.slice(0, 2).join('\n\n');

  // Trailing chatter after the message: a horizontal rule + signature block, or a closing
  // line like "Generated with X" / "Let me know if…". Free models append these constantly.
  s = s.replace(/\n+[-*=~]{3,}\n[\s\S]*$/g, '').trim();
  s = s.replace(/\n+(?:generated (?:with|by|using)[^\n]*|let me know[^\n]*|hope this helps[^\n]*|this commit message[^\n]*)$/gi, '').trim();

  s = s.replace(/^>+\s*/gm, '').trim();

  return s;
}

/** Heuristic: is this output almost certainly not a usable commit message? */
export function looksLikeGarbage(text: string): boolean {
  if (!text || !text.trim()) return true;
  const t = text.trim();
  if (t.length < 5) return true;                       // too short
  if (t.length > 2000) return true;                    // rambling
  if (/[\x00-\x08\x0E-\x1F]/.test(t)) return true;    // control chars / binary noise
  if (REFUSAL_PREFIXES.test(t)) return true;           // refusal or preamble

  if (hasRepeatedLineRun(t, 3)) return true;
  if ((t.match(/^>+\s/gm) || []).length > 3) return true; // mostly quoted block

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

// Markdown rendering for the webview — strict-checked extraction from the
// legacy main.ts (Phase D, PR2). Owns the ONLY code that touches the
// marked/highlight.js/diff2html vendor globals, so this is also where those
// `any` typings get replaced by real (minimal structural) types.
//
// Only `renderMarkdown` is public. `configureMarked` + the `markedReady` flag
// are module-private (called only from renderMarkdown).
import { escapeHtml } from './dom';

// Configure marked ONCE: render embedded raw HTML as escaped TEXT instead of
// live DOM, so a chat message containing an HTML form/snippet shows as readable,
// searchable source — and can't inject widgets/handlers into the webview. Only
// raw `html` tokens are escaped; markdown-generated elements render normally.
let markedReady = false;
function configureMarked(): void {
  if (markedReady || !window.marked) return;
  markedReady = true;
  try {
    window.marked.use({
      renderer: {
        html(token: unknown) {
          const raw = typeof token === 'string'
            ? token
            : (token && typeof token === 'object' && 'raw' in token && token.raw != null
              ? (token as { raw: unknown }).raw
              : (token && typeof token === 'object' && 'text' in token ? (token as { text: unknown }).text : ''));
          return escapeHtml(raw);
        },
      },
    });
  } catch { /* marked optional / older API — fall through to plain parse */ }
}

/**
 * Render a markdown string into a detached DOM node.
 * Parses via marked (GFM + line breaks), strips <script> and neutralizes
 * script-y URLs, syntax-highlights fenced code via highlight.js, and renders
 * ```diff blocks via diff2html. Falls back to a plain text node if marked is
 * unavailable.
 */
export function renderMarkdown(md: string): HTMLElement {
  try {
    if (window.marked) {
      configureMarked();
      const html = window.marked.parse(md, { breaks: true, gfm: true });
      const div = document.createElement('div');
      div.innerHTML = html;
      div.querySelectorAll('script').forEach((s) => s.remove());
      // Neutralize script-y URLs that markdown links/images can still carry (marked v12
      // does not sanitize URLs) — same render sink, cheap defense-in-depth.
      div.querySelectorAll('a[href]').forEach((a) => {
        if (/^\s*(javascript|data|vbscript):/i.test(a.getAttribute('href') || '')) a.removeAttribute('href');
      });
      const hljs = window.hljs;
      if (hljs) div.querySelectorAll('pre code').forEach((b) => { try { hljs.highlightElement(b as HTMLElement); } catch { /* highlight optional */ } });
      // Render diff blocks with diff2html instead of plain syntax highlighting.
      const d2h = window.Diff2Html;
      if (d2h) {
        div.querySelectorAll('pre code.language-diff').forEach((b) => {
          try {
            const diffHtml = d2h.html(b.textContent || '', {
              drawFileList: false,
              matching: 'lines',
              outputFormat: 'line-by-line',
            });
            const wrapper = document.createElement('div');
            wrapper.className = 'd2h-wrapper';
            wrapper.innerHTML = diffHtml;
            b.closest('pre')?.replaceWith(wrapper);
          } catch { /* diff2html optional */ }
        });
      }
      return div;
    }
  } catch { /* fall through to plain text */ }
  const pre = document.createElement('div');
  pre.textContent = md;
  return pre;
}

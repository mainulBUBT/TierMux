// Markdown rendering for the webview — strict-checked extraction from the
// legacy main.ts (Phase D, PR2). Owns the ONLY code that touches the
// marked/highlight.js/diff2html vendor globals, so this is also where those
// `any` typings get replaced by real (minimal structural) types.
//
// Only `renderMarkdown` is public. `configureMarked` + the `markedReady` flag
// are module-private (called only from renderMarkdown).
import { escapeHtml, showToast } from './dom';
import { send } from './bridge';
import { ICON } from './icons';

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
          // Diff2Html expects a proper UNIFIED diff (file headers / @@ hunks).
          // A bare -/+ block (commonly used as pseudo-diff in chat) isn't one —
          // Diff2Html returns empty for it, and replacing the <pre> with an
          // empty .d2h-wrapper would swallow the content entirely. Only hand
          // off to Diff2Html when the content actually looks like a real diff;
          // otherwise leave the code block as-is (hljs handles the rest).
          const src = b.textContent || '';
          const looksLikeDiff = /^(@@|diff --git |diff --cc |Index: |--- |\+\+\+ )/m.test(src);
          if (!looksLikeDiff) return;
          try {
            const diffHtml = d2h.html(src, {
              drawFileList: false,
              matching: 'lines',
              outputFormat: 'line-by-line',
            });
            // Defense-in-depth: if Diff2Html produced nothing, keep the original.
            if (!diffHtml || !diffHtml.trim()) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'd2h-wrapper';
            wrapper.innerHTML = diffHtml;
            b.closest('pre')?.replaceWith(wrapper);
          } catch { /* diff2html optional */ }
        });
      }
      addCodeCopyButtons(div);
      return div;
    }
  } catch { /* fall through to plain text */ }
  const pre = document.createElement('div');
  pre.textContent = md;
  return pre;
}

// Pull a human-readable language name off a fenced block's <code> element. marked emits
// `language-xxx`; highlight.js may add its own `hljs` + detected-language class. Returns '' when
// the fence had no language (a bare ``` block) so the header can fall back to a neutral label.
function codeLangOf(pre: HTMLElement): string {
  const code = pre.querySelector('code');
  const cls = code?.className || '';
  const m = /(?:^|\s)language-([\w+#.-]+)/i.exec(cls);
  return (m?.[1] || '').toLowerCase();
}

const LANG_LABEL: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  py: 'Python', python: 'Python', rb: 'Ruby', php: 'PHP', go: 'Go', rs: 'Rust',
  sh: 'Shell', bash: 'Bash', zsh: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', md: 'Markdown', diff: 'Diff',
  java: 'Java', c: 'C', cpp: 'C++', cs: 'C#', kt: 'Kotlin', swift: 'Swift',
};

// Give every remaining fenced code block (anything diff2html didn't already replace) an AI-SDK-
// Elements-style header bar: a language label on the left and a copy button on the right, above
// the code. Wrapped so the header + pre read as one rounded card.
function addCodeCopyButtons(div: HTMLElement): void {
  div.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('code-block-wrap')) return;
    const code = pre.textContent || '';
    const lang = codeLangOf(pre);

    const wrap = document.createElement('div');
    wrap.className = 'code-block-wrap';
    pre.replaceWith(wrap);

    const head = document.createElement('div');
    head.className = 'code-block-head';
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang ? (LANG_LABEL[lang] || lang) : 'Code';
    head.appendChild(label);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.title = 'Copy code';
    btn.innerHTML = ICON.copy;
    btn.addEventListener('click', () => {
      send({ type: 'copyText', text: code });
      btn.classList.add('ok');
      setTimeout(() => btn.classList.remove('ok'), 1000);
      showToast('Copied', btn);
    });
    head.appendChild(btn);

    wrap.appendChild(head);
    wrap.appendChild(pre);
  });
}

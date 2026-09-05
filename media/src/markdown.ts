// Markdown rendering for the webview — the ONLY code that touches the marked/highlight.js/
// diff2html vendor globals. Public surface: renderMarkdown, appendStreamCursor.
import { escapeHtml, showToast } from './dom';
import { send } from './bridge';
import { ICON } from './icons';
import { mermaidAvailable, renderMermaid } from './mermaid';

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

function cleanThinkTags(text: string): string {
  if (!text) return '';
  let result = text;
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*?<\/(?:think|thinking|thought|reasoning)>/gi, '');
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*$/i, '');
  result = result.replace(/^[\s\S]*?<\/(?:think|thinking|thought|reasoning)>/gi, '');
  result = result.replace(/<\/?(think|thinking|thought|reasoning)>/gi, '');
  return result;
}

/** Render markdown into a detached node: marked (GFM + breaks), <script> and script-y URLs
 *  stripped, fenced code via highlight.js, real unified diffs via diff2html, `path:line`
 *  citations linkified. Plain text node if marked is unavailable. */
export function renderMarkdown(md: string): HTMLElement {
  try {
    const cleanMd = cleanThinkTags(md);
    if (window.marked) {
      configureMarked();
      const html = window.marked.parse(cleanMd, { breaks: true, gfm: true });
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
          // Diff2Html needs a real UNIFIED diff; for a bare -/+ pseudo-diff it returns empty and
          // would swallow the block, so only hand off what looks like one.
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
      linkifyCodeRefs(div);
      addCodeCopyButtons(div);
      return div;
    }
  } catch { /* fall through to plain text */ }
  const pre = document.createElement('div');
  pre.textContent = md;
  return pre;
}

/** A workspace-relative citation in inline code (`src/foo.ts:42[:col]`). Absolute paths cannot
 *  match — openGrepResult joins onto the workspace root — and an extension is required so
 *  `3:14` / `localhost:8080` stay plain. */
const CODE_REF = /^([A-Za-z0-9_.@~-]+\/)*[A-Za-z0-9_.@~-]+\.[A-Za-z0-9]{1,12}:(\d{1,7})(?::\d{1,7})?$/;

/** Turn `path:line` inline-code citations into clickable links (openGrepResult). Inline code
 *  only, and only when the citation is the whole span, so prose is never rewritten. The prompt
 *  asked for these citations long before anything linkified them. */
function linkifyCodeRefs(div: HTMLElement): void {
  div.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre') || code.closest('a')) return;
    const text = (code.textContent || '').trim();
    if (!CODE_REF.test(text)) return;
    const cut = text.indexOf(':');
    const path = text.slice(0, cut);
    const line = parseInt(text.slice(cut + 1), 10);
    if (!path || !Number.isFinite(line) || line < 1) return;
    code.classList.add('code-ref');
    code.setAttribute('role', 'link');
    code.setAttribute('tabindex', '0');
    code.title = `Open ${path} at line ${line}`;
    const open = () => send({ type: 'openGrepResult', path, line });
    code.addEventListener('click', open);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

/** Block containers whose last child we keep descending through while hunting the element
 *  that visually ends a streamed message (a trailing nested list's innermost item, the
 *  paragraph closing a blockquote or a loose li). P/H1–H6 are safe to enter — markdown only
 *  puts inline content inside them, so the walk always terminates right after. */
const CURSOR_DESCEND = new Set(['UL', 'OL', 'LI', 'BLOCKQUOTE', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV']);

/** Append the single streaming caret to the element that visually ends the message: walk the
 *  last-child chain through list/blockquote structure and stop at the first non-container. CSS
 *  `:last-child::after` is scoped per parent and blinked several carets in nested lists. */
export function appendStreamCursor(root: HTMLElement): void {
  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  cursor.textContent = '▍';
  let el: HTMLElement = root;
  for (;;) {
    const last = el.lastElementChild as HTMLElement | null;
    if (!last || !CURSOR_DESCEND.has(last.tagName)
      || last.matches('pre, table, .code-block-wrap, .mermaid-block, .d2h-wrapper')) break;
    el = last;
  }
  el.appendChild(cursor);
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
  mermaid: 'Diagram',
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
    if (lang) wrap.dataset.lang = lang;
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

    if (lang === 'mermaid') attachDiagram(wrap, head, btn, code);
  });
}

/** Upgrade a ```mermaid block into a diagram with a Diagram/Source toggle. The code block IS the
 *  fallback: an unsupported type, missing bundle or half-streamed fence simply reads as source. */
function attachDiagram(wrap: HTMLElement, head: HTMLElement, copyBtn: HTMLElement, src: string): void {
  if (!mermaidAvailable()) return;
  wrap.classList.add('mermaid-block');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'code-copy-btn diagram-toggle';
  toggle.hidden = true; // revealed only once there is a diagram to switch to
  head.insertBefore(toggle, copyBtn);

  const syncToggle = () => {
    const showingSource = wrap.classList.contains('show-source');
    toggle.innerHTML = showingSource ? ICON.eye : ICON.code;
    toggle.title = showingSource ? 'Show diagram' : 'Show source';
  };
  toggle.addEventListener('click', () => {
    wrap.classList.toggle('show-source');
    syncToggle();
  });
  syncToggle();

  renderMermaid(src).then((host) => {
    if (!host) return;
    wrap.insertBefore(host, wrap.querySelector('pre'));
    wrap.classList.add('rendered');
    toggle.hidden = false;
  });
}

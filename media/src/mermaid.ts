// Mermaid rendering for ```mermaid fences. Three constraints:
//  1. SIZE — the ~3.5 MB bundle is injected on demand by loadMermaid(), never a <script> tag.
//  2. CSP — a nonce disables 'unsafe-inline' and does not cover style="" attributes; mermaid
//     needs both, so adoptStyles() rewrites everything into one nonce-carrying stylesheet.
//  3. STREAMING — renderMarkdown re-runs per chunk, so `mermaid.parse` gates: a half-written
//     fence stays a code block and the complete render swaps in the SVG. No error UI mid-stream.

let mermaidPromise: Promise<Mermaid | null> | null = null;

/** Inject the mermaid bundle once and resolve with the global it defines (null if unavailable). */
function loadMermaid(): Promise<Mermaid | null> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise<Mermaid | null>((resolve) => {
    if (window.mermaid) return resolve(window.mermaid);
    const src = window.__MERMAID_URI__;
    const nonce = window.__NONCE__;
    if (!src || !nonce) return resolve(null);
    const s = document.createElement('script');
    // Both forms: the attribute is what CSP matches, the property is what
    // Chromium's nonce-hiding keeps readable for script-inserted elements.
    s.setAttribute('nonce', nonce);
    s.nonce = nonce;
    s.src = src;
    s.onload = () => {
      const m = window.mermaid;
      if (!m) return resolve(null);
      try {
        m.initialize({
          startOnLoad: false,
          // 'strict' makes mermaid sanitize HTML in diagram labels — chat content
          // is model/user authored, so it must not be able to inject markup here.
          securityLevel: 'strict',
          theme: isDarkTheme() ? 'dark' : 'default',
          fontFamily: 'var(--vscode-font-family, sans-serif)',
          // We render our own fallback (the original code block) on failure;
          // mermaid's built-in error diagram would replace it with a red "bomb".
          suppressErrorRendering: true,
        });
      } catch { /* older/newer config shape — defaults are still usable */ }
      resolve(m);
    };
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return mermaidPromise;
}

/** VS Code stamps `vscode-dark` / `vscode-high-contrast` on <body> for dark themes. */
function isDarkTheme(): boolean {
  const c = document.body.className || '';
  return /vscode-dark|vscode-high-contrast(?!-light)/.test(c);
}

// mermaid.render mutates shared module state and a temp DOM node, so concurrent
// calls can interleave badly. One chain keeps every diagram on the page serial.
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

/** Render `src` into a detached container (SVG + CSP-safe stylesheet); null when mermaid is
 *  unavailable or the source is not (yet) valid — the caller keeps the code block. */
export function renderMermaid(src: string): Promise<HTMLElement | null> {
  const job = renderQueue.then(async () => {
    const m = await loadMermaid();
    if (!m) return null;
    const id = `tm-mermaid-${++renderSeq}`;
    try {
      // Gate on parse: mid-stream fences are incomplete, not broken.
      const ok = await m.parse(src, { suppressErrors: true });
      if (ok === false) return null;
      const { svg } = await m.render(id, src);
      const host = document.createElement('div');
      host.className = 'mermaid-render';
      host.innerHTML = svg;
      adoptStyles(host, id);
      return host;
    } catch {
      return null;
    }
  });
  // Keep the chain alive even when one diagram rejects.
  renderQueue = job.catch(() => null);
  return job.catch(() => null);
}

/** Move every style mermaid emitted into one nonce-carrying <style>: the SVG's <style> block is
 *  re-emitted with the nonce, and each `style="…"` attribute becomes a `.tm-mi-N` rule with
 *  `!important` so it still beats mermaid's higher-specificity selectors. */
function adoptStyles(host: HTMLElement, id: string): void {
  const nonce = window.__NONCE__;
  if (!nonce) return;
  const css: string[] = [];

  host.querySelectorAll('style').forEach((s) => {
    css.push(s.textContent || '');
    s.remove();
  });

  let n = 0;
  host.querySelectorAll<Element>('[style]').forEach((node) => {
    const decls = (node.getAttribute('style') || '')
      .split(';')
      .map((d) => d.trim().replace(/\s*!important\s*$/i, ''))
      .filter(Boolean);
    node.removeAttribute('style');
    if (!decls.length) return;
    const cls = `${id}-s${++n}`;
    // SVG elements have a read-only `className`, so go through the attribute.
    node.setAttribute('class', `${node.getAttribute('class') || ''} ${cls}`.trim());
    css.push(`.${cls}{${decls.map((d) => `${d} !important`).join(';')}}`);
  });

  if (!css.length) return;
  const style = document.createElement('style');
  style.setAttribute('nonce', nonce);
  style.nonce = nonce;
  style.textContent = css.join('\n');
  // After the SVG so equal-specificity rules resolve in the adopted sheet's favor.
  host.appendChild(style);
}

/** True when the webview can render diagrams at all (bundle wired up by the host). */
export function mermaidAvailable(): boolean {
  return Boolean(window.__MERMAID_URI__ && window.__NONCE__);
}

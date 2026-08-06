// Mermaid diagram rendering for ```mermaid fenced blocks in chat markdown.
//
// Three constraints shape this file:
//
//  1. SIZE — the mermaid bundle is ~3.5 MB, far larger than every other webview
//     vendor combined. It is therefore NOT a <script> tag in the webview HTML;
//     `loadMermaid()` injects it on demand the first time a mermaid fence is
//     rendered, so a session that never shows a diagram never pays for it.
//
//  2. CSP — the webview runs under `style-src <cspSource> 'nonce-…'`. A nonce
//     disables 'unsafe-inline' entirely, and nonces do not apply to `style=""`
//     ATTRIBUTES. Mermaid's output relies on both a <style> block and inline
//     style attributes, so `adoptStyles()` rewrites both into one nonce-carrying
//     stylesheet. Without this, diagrams render unstyled.
//
//  3. STREAMING — renderMarkdown re-runs on every streamed chunk, so a mermaid
//     fence is usually seen half-written first. `mermaid.parse` gates on that:
//     an incomplete diagram just stays a plain code block, and the final
//     (complete) render swaps in the SVG. No error UI ever flashes mid-stream.

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

/**
 * Render `src` and hand back a detached container holding the SVG plus its
 * CSP-safe stylesheet. Resolves null when mermaid is unavailable or the source
 * is not (yet) a valid diagram — the caller keeps showing the code block.
 */
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

/**
 * Move every style mermaid emitted into a single nonce-carrying <style>, because
 * the webview CSP allows neither un-nonced <style> blocks nor style attributes:
 *   - the SVG's own <style> block is re-emitted as an HTML <style nonce=…>
 *   - each `style="…"` attribute becomes a generated `.tm-mi-N` class rule
 * Declarations lifted off attributes get `!important` so they keep beating
 * mermaid's own (higher-specificity) `#id .node rect` rules, the way the inline
 * attribute they came from used to.
 */
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

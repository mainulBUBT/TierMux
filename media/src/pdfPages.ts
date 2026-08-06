// Rasterize a scanned PDF's pages to images, in the webview.
//
// WHY HERE and not in the extension host: a PDF with no text layer can only be read by a
// model that can SEE it, and only Google forwards raw PDF bytes — every other provider
// silently drops the file part. Rendering the pages to ordinary images fixes that for every
// vision-capable model. Host-side rendering needs @napi-rs/canvas, whose native binding
// Electron refuses to load ("Failed to load native binding"), so it can never work there.
// The webview is a real browser: <canvas> is native, no binary required.
//
// Two constraints shape this file:
//
//  1. SIZE — pdf.js + its worker are ~1.4 MB, so they are NOT script tags in the webview
//     HTML. `loadPdfJs()` injects them on demand the first time a scanned PDF is attached;
//     a session that never attaches one never pays for it (same approach as mermaid).
//
//  2. CSP — the webview runs under `script-src <cspSource> 'nonce-…'`. pdf.js is an ES
//     module, and a module's own `import` is matched against the SOURCE LIST, not the nonce
//     (a nonce only authorizes the <script> element itself). So the loader injects a nonced
//     inline module whose `import` is allowed by cspSource, and hands the namespace back on
//     `window.__pdfjsLib__`. Its worker is likewise loaded from cspSource (`worker-src`).

/** Hard cap on rendered pages — each page becomes a separate image in the request, which is
 *  expensive in tokens and payload size, so a huge scan contributes a usable prefix instead
 *  of failing outright. Mirrors the notice text shown when a PDF is truncated. */
const MAX_PAGES = 20;
/** Render scale. 1.5x keeps small print legible without ballooning the payload. */
const SCALE = 1.5;
/** JPEG beats PNG by ~5x on photographic/scanned pages at visually identical quality. */
const MIME = 'image/jpeg';
const QUALITY = 0.82;
/** Skip any page whose encoded size would blow the per-image budget (mirrors the host cap). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let pdfjsPromise: Promise<PdfJsLib | null> | null = null;

/** Inject pdf.js once and resolve with its module namespace (null if unavailable). */
function loadPdfJs(): Promise<PdfJsLib | null> {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = new Promise<PdfJsLib | null>((resolve) => {
    if (window.__pdfjsLib__) return resolve(window.__pdfjsLib__);
    const src = window.__PDFJS_URI__;
    const workerSrc = window.__PDFJS_WORKER_URI__;
    const nonce = window.__NONCE__;
    if (!src || !workerSrc || !nonce) return resolve(null);

    const done = (ok: boolean): void => {
      window.removeEventListener('__pdfjs_ready', onReady);
      if (!ok) return resolve(null);
      const lib = window.__pdfjsLib__;
      if (!lib) return resolve(null);
      // Point pdf.js at our vendored worker; without this it tries to derive a path from its
      // own URL and fails under the webview's resource scheme.
      try { lib.GlobalWorkerOptions.workerSrc = workerSrc; } catch { /* older shape */ }
      resolve(lib);
    };
    const onReady = (): void => done(true);
    window.addEventListener('__pdfjs_ready', onReady, { once: true });

    const s = document.createElement('script');
    s.type = 'module';
    // Both forms: the attribute is what CSP matches, the property is what Chromium's
    // nonce-hiding keeps readable for script-inserted elements.
    s.setAttribute('nonce', nonce);
    s.nonce = nonce;
    s.textContent =
      `import * as pdfjsLib from ${JSON.stringify(src)};\n` +
      `window.__pdfjsLib__ = pdfjsLib;\n` +
      `window.dispatchEvent(new Event('__pdfjs_ready'));`;
    s.onerror = () => done(false);
    document.head.appendChild(s);
  });
  return pdfjsPromise;
}

/** Decode a `data:` URL's base64 payload to bytes for pdf.js. */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export interface PdfRenderResult {
  /** Rendered page images as `data:` URLs, in page order. Empty when rendering failed. */
  pages: string[];
  /** Total page count in the document (may exceed pages.length — see MAX_PAGES). */
  total: number;
  /** Why nothing was rendered, for the user-facing notice. Undefined on success. */
  error?: string;
}

/**
 * Render the first pages of a PDF `data:` URL to image `data:` URLs.
 * Never throws — a failure resolves with `pages: []` and a reason, so the caller can fall
 * back to sending the raw file (which only Google can read) rather than losing the turn.
 */
export async function renderPdfToPageImages(dataUrl: string): Promise<PdfRenderResult> {
  const lib = await loadPdfJs();
  if (!lib) return { pages: [], total: 0, error: 'pdf.js failed to load' };
  const bytes = dataUrlToBytes(dataUrl);
  if (!bytes) return { pages: [], total: 0, error: 'could not decode the PDF data' };

  let doc: PdfJsDocument | undefined;
  try {
    doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const total = doc.numPages;
    const count = Math.min(total, MAX_PAGES);
    const pages: string[] = [];
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        // Scans are photographic: a white base avoids transparent areas turning black in JPEG.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        const url = canvas.toDataURL(MIME, QUALITY);
        // base64 is ~4/3 of the raw bytes.
        if (url.startsWith('data:image/') && (url.length * 3) / 4 <= MAX_IMAGE_BYTES) pages.push(url);
      } finally {
        page.cleanup?.();
      }
    }
    return pages.length ? { pages, total } : { pages: [], total, error: 'no pages could be rendered' };
  } catch (e) {
    return { pages: [], total: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await doc?.destroy?.().catch(() => { /* best-effort cleanup */ });
  }
}

export { MAX_PAGES as PDF_MAX_RENDER_PAGES };

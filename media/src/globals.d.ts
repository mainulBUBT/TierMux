// Ambient declarations for what the webview environment provides: vendor scripts (loaded as
// <script> tags by chatViewProvider.ts) and the VS Code-injected API. Vendor typings are MINIMAL
// structural interfaces covering only what TierMux calls — broaden only when a new method is
// used. Wrapped in `declare global` because the `export {}` makes this file a module.

// ---- Minimal vendor interfaces (only what's used) ----
interface MarkedRenderer { html?: (token: unknown) => string }
interface Marked {
  use(opts: { renderer?: MarkedRenderer }): void;
  parse(md: string, opts: { breaks?: boolean; gfm?: boolean }): string;
}
interface Hljs { highlightElement(el: HTMLElement): void }
interface Diff2Html {
  html(diff: string, opts: {
    drawFileList?: boolean;
    matching?: 'lines' | 'words' | 'none';
    outputFormat?: 'line-by-line' | 'side-by-side';
  }): string;
}
interface Mermaid {
  initialize(config: {
    startOnLoad?: boolean;
    securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox';
    theme?: 'default' | 'dark' | 'neutral' | 'forest' | 'base';
    fontFamily?: string;
    suppressErrorRendering?: boolean;
  }): void;
  /** Throws on invalid diagram source (used as the "is this fence complete yet?" gate). */
  parse(text: string, opts?: { suppressErrors?: boolean }): Promise<boolean | void>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

declare global {
  // Vendor globals — UMD builds attach to BOTH a bare global and `window`, and
  // the existing code uses both access styles (`marked` and `window.marked`).
  // Declaring both keeps the declarations matched to runtime.
  const marked: Marked | undefined;
  const hljs: Hljs | undefined;
  const Diff2Html: Diff2Html | undefined;
  const mermaid: Mermaid | undefined;

  interface Window {
    marked?: Marked;
    hljs?: Hljs;
    Diff2Html?: Diff2Html;
    /** Set by the mermaid bundle once markdown.ts lazily injects it. */
    mermaid?: Mermaid;
    /** CSP nonce for this webview document — required to inject the mermaid <script> and its <style>. */
    __NONCE__?: string;
    /** Webview URI of media/vendor/mermaid.min.js (lazily loaded). */
    __MERMAID_URI__?: string;
    /** Webview URI of media/vendor/pdf.min.mjs — pdf.js, lazily loaded by pdfPages.ts. */
    __PDFJS_URI__?: string;
    /** Webview URI of media/vendor/pdf.worker.min.mjs — pdf.js's parser worker. */
    __PDFJS_WORKER_URI__?: string;
    /** Set by the inline module shim in pdfPages.ts once pdf.js has been imported. */
    __pdfjsLib__?: PdfJsLib;
  }

  /** The slice of pdf.js's API this webview uses. */
  interface PdfJsLib {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): {
      promise: Promise<PdfJsDocument>;
    };
  }
  interface PdfJsDocument {
    numPages: number;
    getPage(n: number): Promise<PdfJsPage>;
    destroy?(): Promise<void>;
  }
  interface PdfJsPage {
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: { canvas?: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
    cleanup?(): void;
  }

  // VS Code injects acquireVsCodeApi() into the webview before our script runs.
  function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(s: unknown): void;
  };
}

export {};

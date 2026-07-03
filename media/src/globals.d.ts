// Ambient declarations for what the webview environment provides but our own
// TS does not own: vendor scripts (loaded as separate <script> tags by the
// extension host in chatViewProvider.ts) and the VS Code-injected API.
//
// Vendor typings: replaced the temporary `any` (Phase D, PR2) with MINIMAL
// STRUCTURAL interfaces covering only the methods TierMux actually calls. We
// intentionally do NOT pull in the full vendor type packages — over-typing
// adds churn for surfaces we don't use. Broaden these interfaces only when a
// new vendor method is actually called.
//
// Everything here is wrapped in `declare global` because this file is a module
// (the `export {}` below) — without that, top-level `declare`s would be
// module-scoped and invisible to main.ts.

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

declare global {
  // Vendor globals — UMD builds attach to BOTH a bare global and `window`, and
  // the existing code uses both access styles (`marked` and `window.marked`).
  // Declaring both keeps the declarations matched to runtime.
  const marked: Marked | undefined;
  const hljs: Hljs | undefined;
  const Diff2Html: Diff2Html | undefined;

  interface Window {
    marked?: Marked;
    hljs?: Hljs;
    Diff2Html?: Diff2Html;
  }

  // VS Code injects acquireVsCodeApi() into the webview before our script runs.
  function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(s: unknown): void;
  };
}

export {};

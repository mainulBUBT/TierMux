// Ambient declarations for what the webview environment provides but our own
// TS does not own: vendor scripts (loaded as separate <script> tags by the
// extension host in chatViewProvider.ts) and the VS Code-injected API.
//
// TODO(Phase C): replace the vendor `any` typings with proper types per vendor,
// so these temporary `any`s don't become permanent.
//
// Everything here is wrapped in `declare global` because this file is a module
// (the `export {}` below) — without that, top-level `declare`s would be
// module-scoped and invisible to main.ts.

declare global {
  // Vendor globals — UMD builds attach to BOTH a bare global and `window`, and
  // the existing code uses both access styles (`marked` and `window.marked`).
  // Declaring both keeps the declarations matched to runtime.
  const marked: any;
  const hljs: any;
  const Diff2Html: any;

  interface Window {
    marked: any;
    hljs: any;
    Diff2Html: any;
  }

  // VS Code injects acquireVsCodeApi() into the webview before our script runs.
  function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(s: unknown): void;
  };
}

export {};

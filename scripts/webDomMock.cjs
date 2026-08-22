/**
 * Webview-DOM mock for e2e harnesses that import media/src/** UI modules under plain Node.
 * Required BEFORE the bundled module (-r ./scripts/webDomMock.cjs) because some webview
 * modules call acquireVsCodeApi() at module scope (bridge.ts) and touch document/window.
 */
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// DOM built-ins referenced as bare identifiers by ui/dom.ts and friends.
for (const key of ['Node', 'Element', 'HTMLElement', 'HTMLDetailsElement', 'HTMLPreElement', 'DocumentFragment', 'TextEncoder', 'TextDecoder']) {
  if (dom.window[key] && !globalThis[key]) globalThis[key] = dom.window[key];
}
if (!globalThis.TextEncoder) globalThis.TextEncoder = require('util').TextEncoder;
if (!globalThis.TextDecoder) globalThis.TextDecoder = require('util').TextDecoder;

let used = false;
globalThis.acquireVsCodeApi = function () {
  if (used) throw new Error('acquireVsCodeApi may be called at most once');
  used = true;
  return { postMessage() {}, getState() { return {}; }, setState() {} };
};

// No window.Diff2Html / hljs vendors on purpose — dependent code must degrade gracefully.

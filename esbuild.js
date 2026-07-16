// Build script for the tiermux extension.
// - Bundles src/extension.ts -> dist/extension.js (node/cjs, vscode external).
// - Bundles media/src/main.ts -> media/main.js (browser/iife, the webview UI).
// - Copies the webview vendor assets (marked + highlight.js) into media/vendor/.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Copy a file, creating the destination directory if needed. */
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Copy the offline webview vendor assets from node_modules into media/vendor/. */
function copyVendor() {
  const vendorDir = path.join(__dirname, 'media', 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });

  // marked: browser UMD build.
  const markedUmd = path.join(__dirname, 'node_modules', 'marked', 'marked.min.js');
  if (fs.existsSync(markedUmd)) {
    copy(markedUmd, path.join(vendorDir, 'marked.min.js'));
  } else {
    console.warn('[esbuild] marked.min.js not found — run npm install');
  }

  // highlight.js: bundled browser build with only the languages TierMux
  // actually uses in code blocks. The full bundle is ~1 MB; this slimmed
  // version is ~200 KB and covers >95% of the syntaxes users paste.
  const hljsCommon = path.join(__dirname, 'node_modules', 'highlight.js', 'lib', 'common.js');
  // Prefer the prebuilt browser bundle when present (already small + minified).
  const hljsBrowser = path.join(__dirname, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js');
  if (fs.existsSync(hljsBrowser)) {
    copy(hljsBrowser, path.join(vendorDir, 'highlight.min.js'));
  } else if (fs.existsSync(hljsCommon)) {
    // Build a custom highlight.js bundle with only the languages we need.
    // `common.js` is a curated subset (~35 languages) maintained by the
    // highlight.js team for the "common" CDN build.
    esbuild.buildSync({
      entryPoints: [hljsCommon],
      bundle: true,
      format: 'iife',
      globalName: 'hljs',
      minify: true,
      outfile: path.join(vendorDir, 'highlight.min.js'),
      platform: 'browser',
    });
  } else {
    console.warn('[esbuild] highlight.js not found — run npm install');
  }

  const hljsTheme = path.join(__dirname, 'node_modules', 'highlight.js', 'styles', 'github-dark.css');
  if (fs.existsSync(hljsTheme)) {
    copy(hljsTheme, path.join(vendorDir, 'highlight.css'));
  }

  // diff2html: pre-minified browser bundle (CSS + core JS). Used by the chat
  // webview to render unified/split diffs. These are referenced in
  // chatViewProvider.ts:2024,2033 — without them the webview logs 404s.
  const d2hCss = path.join(__dirname, 'node_modules', 'diff2html', 'bundles', 'css', 'diff2html.min.css');
  if (fs.existsSync(d2hCss)) {
    copy(d2hCss, path.join(vendorDir, 'diff2html.min.css'));
  } else {
    console.warn('[esbuild] diff2html.min.css not found — run npm install');
  }
  const d2hJs = path.join(__dirname, 'node_modules', 'diff2html', 'bundles', 'js', 'diff2html.min.js');
  if (fs.existsSync(d2hJs)) {
    copy(d2hJs, path.join(vendorDir, 'diff2html.min.js'));
  } else {
    console.warn('[esbuild] diff2html.min.js not found — run npm install');
  }
}

// Emits begin/end markers per build so VS Code's background problemMatcher (in
// tasks.json) knows when a watch rebuild starts/finishes — this is what lets
// F5 launch the dev host. Each context gets its own labeled status so it's
// clear which build (extension vs webview) succeeded or failed.
function watchLogPlugin(label) {
  return {
    name: `watch-log-${label}`,
    setup(build) {
      build.onStart(() => console.log(`[${label}] build started`));
      build.onEnd((result) => console.log(`[${label}] build finished with ${result.errors.length} error(s)`));
    },
  };
}

// Browser import boundary for the webview bundle. The webview runs in a
// browser, so it may ONLY import from its own media/src/** tree and from
// src/shared/** (type-only). Anything else under src/ (router, providers,
// agent, …) is Node/vscode-coupled and must never enter the browser bundle.
// Enforced at BUILD time — a violation fails the build with a clear message,
// so it can't slip through to the bundle. (Cheaper than a separate lint step
// and has zero new dependencies.)
const ALLOWED_PREFIXES = ['media/src/', 'src/shared/', 'node_modules/'];
function boundaryPlugin() {
  return {
    name: 'webview-import-boundary',
    setup(build) {
      // `onResolve` fires for every import the bundler follows. `importer` is
      // the file doing the import; we only police imports originating inside
      // media/src so the rule can't false-positive on the extension build.
      build.onResolve({ filter: /.*/ }, (args) => {
        const importer = args.importer || '';
        if (!importer.replace(/\\/g, '/').includes('media/src/')) return null;
        const spec = args.path || '';
        // Bare specifiers (node_modules / vendor globals) are allowed.
        if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
        // Resolve the import against the IMPORTING FILE's directory (not the literal
        // specifier string) — "../bridge" from media/src/handlers/watchdog.ts stays
        // inside media/src/ and must not be flagged just because it starts with "../".
        const resolved = path.resolve(args.resolveDir || path.dirname(importer), spec).replace(/\\/g, '/');
        if (ALLOWED_PREFIXES.some((p) => resolved.includes(`/${p}`))) return null;
        return {
          errors: [{
            text: `Webview import boundary violation: media/src/** may only import from media/src/** or src/shared/** (type-only). Saw import of "${args.path}" from ${importer}.`,
          }],
        };
      });
    },
  };
}

// Banner injected into the generated webview bundle so the built file is
// self-documenting — it is a generated artifact, not a hand-edited source.
const WEBVIEW_BANNER = `/**
 * AUTO-GENERATED — DO NOT EDIT.
 * Source:       media/src/main.ts
 * Generated by: esbuild (npm run build)
 * Target:       webview (browser bundle)
 */`;

async function buildOnce(ctx) {
  const result = await ctx.rebuild();
  await ctx.dispose();
  return result;
}

async function main() {
  copyVendor();

  // Extension host (Node/CJS, vscode external).
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    plugins: watch ? [watchLogPlugin('extension')] : [],
  });

  // Webview UI (browser IIFE). Bundles media/src/main.ts and its imports into
  // the single media/main.js the webview loads. Inline sourcemaps in dev for
  // browser DevTools debugging (the webview has no Node debugger); off in prod.
  // `__DEV__` is the dev flag the webview branches on (cleaner than process.env
  // in a browser bundle).
  const webviewCtx = await esbuild.context({
    entryPoints: ['media/src/main.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: 'media/main.js',
    sourcemap: production ? false : 'inline',
    minify: production,
    logLevel: 'info',
    banner: { js: WEBVIEW_BANNER },
    define: { __DEV__: JSON.stringify(!production) },
    plugins: [boundaryPlugin(), ...(watch ? [watchLogPlugin('webview')] : [])],
  });

  if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
    console.log('[esbuild] watching…');
  } else {
    // One-shot: both must succeed. An initial build failure must fail the whole
    // build (non-zero exit) even if the other built fine, so a broken artifact
    // can't ship. (In watch mode above, a failure does NOT exit — the watch
    // process stays alive and the labeled status line surfaces the error count,
    // so a transient error doesn't kill the dev loop.)
    let failed = false;
    for (const ctx of [extensionCtx, webviewCtx]) {
      const result = await buildOnce(ctx);
      if (result.errors.length > 0) failed = true;
    }
    if (failed) process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

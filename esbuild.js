// Build script for the free-llm-agent extension.
// - Bundles src/extension.ts -> dist/extension.js (node/cjs, vscode external).
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

/** Copy the offline webview vendor assets from node_modules into media/vendor. */
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

  // highlight.js: bundled browser build + a dark theme.
  const hljs = path.join(__dirname, 'node_modules', 'highlight.js', 'lib', 'index.js');
  // Prefer the prebuilt browser bundle when present.
  const hljsBrowser = path.join(__dirname, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js');
  if (fs.existsSync(hljsBrowser)) {
    copy(hljsBrowser, path.join(vendorDir, 'highlight.min.js'));
  } else if (fs.existsSync(hljs)) {
    // Bundle highlight.js for the browser ourselves.
    esbuild.buildSync({
      entryPoints: [hljs],
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
}

async function main() {
  copyVendor();

  const ctx = await esbuild.context({
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
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching…');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

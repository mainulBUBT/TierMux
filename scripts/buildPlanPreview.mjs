/** Bundles scripts/planCardPreview.ts and wraps it in a standalone HTML page with the real
 *  token + component CSS inlined, plus a stub for the --vscode-* theme variables the webview
 *  normally inherits from the editor (absent in a plain browser, which would otherwise render
 *  every colour empty). Output: dist/planCardPreview.html. */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Card text comes from the real formatPlanForCard, bundled for node so its vscode/router
// neighbours stay out of the browser bundle.
const fmtBundle = await build({
  entryPoints: ['src/agent/planStructurer.ts'],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['vscode', 'ai'],  // zod is pure JS and used at module scope — let it bundle
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', fmtBundle.outputFiles[0].text)(
  // planStructurer imports `ai`/`zod` at module scope for its OTHER exports; formatPlanForCard
  // touches neither, so a permissive stub is enough to evaluate the module.
  mod, mod.exports, () => new Proxy({}, { get: () => () => {} }),
);
const { formatPlanForCard } = mod.exports;

const FIXTURES = {
  withQuestions: formatPlanForCard({
    outcome: 'plan',
    title: 'Hide inactive products in order edit mode',
    interpretation: 'in edit mode, products whose category or status is off should be HIDDEN from the grid',
    approach: 'filter in the controller query so inactive items never reach the blade template',
    description: 'Adds the status and category checks the edit-mode grid is missing.',
    questions: [{
      question: 'Fix the shared scope, or only the vendor order view?',
      background: 'app/Models/Item.php:120 checks the parent category only, so the fix is shared by default',
      options: ['Shared scope', 'Vendor view only'],
    }],
    steps: [
      { what: 'Add a sub-category status check to Item::scopeActive', files: ['app/Models/Item.php'],
        evidence: 'app/Models/Item.php:120 validates the parent status but never the sub-category',
        verify: 'php artisan test --filter=ItemScope' },
      { what: 'Confirm the vendor grid query inherits the tightened scope',
        files: ['app/Http/Controllers/Vendor/OrderController.php'],
        evidence: 'app/Http/Controllers/Vendor/OrderController.php:263 chains ->active()' },
    ],
  }),
  clean: formatPlanForCard({
    outcome: 'plan',
    title: 'Add a dark mode toggle',
    interpretation: 'the settings panel should offer a light/dark choice the webview honours',
    approach: 'store it as an ordinary setting so the webview reads it like every other one',
    description: 'Wires a theme setting through the settings panel and the webview.',
    steps: [
      { what: 'Add a themeMode setting', files: ['src/settingsMeta.ts'],
        evidence: 'src/settingsMeta.ts:40 has no theme entry', verify: 'npm run typecheck' },
      { what: 'Read the toggle when rendering the panel', files: ['media/src/main.ts'],
        evidence: 'media/src/main.ts:210 hardcodes the light palette' },
    ],
  }),
};

const out = await build({
  entryPoints: ['scripts/planCardPreview.ts'],
  bundle: true, format: 'iife', platform: 'browser', write: false,
  external: ['vscode'],
  define: { __PLAN_FIXTURES__: JSON.stringify(FIXTURES) },
});
const js = out.outputFiles[0].text;
const css = ['media/styles/tokens.css', 'media/styles/components/plan.css']
  .map((f) => readFileSync(f, 'utf8')).join('\n');

// Dark-theme stand-ins for the editor variables. Values follow VS Code's Dark Modern so the
// preview reads like the real panel rather than like unstyled HTML.
const themeStub = `:root{
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --vscode-editor-font-family: "SF Mono", Menlo, Consolas, monospace;
  --vscode-foreground:#cccccc; --vscode-descriptionForeground:#9d9d9d;
  --vscode-editor-background:#1f1f1f; --vscode-sideBar-background:#181818;
  --vscode-editorWidget-background:#202020; --vscode-editorHoverWidget-background:#252526;
  --vscode-editor-inactiveSelectionBackground:#3a3d41;
  --vscode-input-background:#313131; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
  --vscode-panel-border:#2b2b2b; --vscode-editorWidget-border:#454545; --vscode-focusBorder:#0078d4;
  --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff;
  --vscode-badge-background:#616161; --vscode-badge-foreground:#f8f8f8;
  --vscode-dropdown-background:#313131; --vscode-dropdown-foreground:#cccccc; --vscode-dropdown-border:#3c3c3c;
  --vscode-list-hoverBackground:#2a2d2e; --vscode-list-activeSelectionBackground:#04395e;
  --vscode-toolbar-hoverBackground:#383a49; --vscode-notifications-background:#1f1f1f;
  --vscode-textCodeBlock-background:#2b2b2b; --vscode-textLink-foreground:#4daafc;
  --vscode-textLink-activeForeground:#4daafc; --vscode-errorForeground:#f85149;
  --vscode-charts-blue:#3794ff; --vscode-charts-yellow:#cca700; --vscode-testing-iconPassed:#3fb950;
  --vscode-progressBar-background:#0078d4;
}`;

const html = `<!doctype html><meta charset="utf-8"><title>TierMux — Plan card preview</title>
<style>
${themeStub}
${css}
body{margin:0;padding:24px;background:var(--vscode-sideBar-background);color:var(--tm-fg);
  font-family:var(--vscode-font-family);font-size:13px;}
.pv-case{max-width:420px;margin:0 0 32px;}
.pv-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--tm-fg-muted);margin-bottom:8px;}
</style>
<body><script>${js}</script>`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/planCardPreview.html', html);
console.log(`dist/planCardPreview.html  (${(html.length / 1024).toFixed(1)} kB) — open it in a browser`);

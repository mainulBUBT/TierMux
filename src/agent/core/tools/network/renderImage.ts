// renderImage — HTML/SVG → PNG through the user's own headless Chrome (cdp.ts, the browserVerify
// launcher). Banners, OG images, social cards, diagrams: the way Codex's imagegen skill says to
// make them when they are text + layout ("prefer HTML/CSS/canvas/SVG over a bitmap model"), at
// zero model cost and with no new dependency. The result reports what can be checked
// mechanically (content overflowing the canvas, text cut off, broken images, failed fonts) and,
// for a vision model, carries a small JPEG of the render so it can judge what geometry cannot:
// contrast, legibility, balance. The router sends those pixels only to candidates that read
// images (routerProvider withoutToolImages) — a text-only model gets a note instead.
//
// Network policy: the markup is model-written, so it gets the fetchUrl line — data/blob, the
// workspace's own files, and public http(s) (web fonts, remote images); never loopback or private
// addresses.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { effectiveRootUri } from '../workspaceRoot';
import { CdpPipeClient, findChromePath } from './cdp';
import { withDeadline } from './browserVerify';
import { keepToolImage, toolImageOutput } from './toolImages';
import { isHostResolvingToPrivate } from './tiermuxWeb/fetcher/safe-fetch';
import { notifyGraphicRendered } from '../../../../preview/graphicPreview';

const HARD_DEADLINE_MS = 45_000;
const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_MS = 300;
const MAX_SIDE = 4096;
const MAX_ISSUES = 6;
/** Longest side of the preview a vision model sees — enough to judge a design, ~1k tokens. */
const PREVIEW_MAX_SIDE = 1024;


export interface RenderImageBindings {
  chromePath?: string;
  deadlineMs?: number;
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
/** WebSocket handshakes skip the Fetch interception renderRequestAllowed rides on (live probe
 *  2026-11-12: a file:// render reached ws://127.0.0.1 and ws://localhost). Unresolvable
 *  loopback/private literals stop them in the network stack. Exported for e2e. */
export const LOCAL_NETWORK_RESOLVER_RULES = '--host-resolver-rules=' + [
  'localhost', '*.localhost', '127.*', '0.0.0.0', '[::1]', '10.*', '192.168.*', '169.254.*',
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
].map((h) => `MAP ${h} ~NOTFOUND`).join(', ');

/** Request policy for a render. Pure apart from the DNS lookup (cached per host). */
export async function renderRequestAllowed(url: string, fileRoots: string[], dnsCache: Map<string, boolean>): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
  if (u.protocol === 'file:') {
    const p = path.resolve(decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    return fileRoots.some((r) => p === r || p.startsWith(r + path.sep));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (LOCAL_NAMES.has(u.hostname)) return false;
  let priv = dnsCache.get(u.hostname);
  if (priv === undefined) {
    priv = await isHostResolvingToPrivate(u.hostname);
    dnsCache.set(u.hostname, priv);
  }
  return !priv;
}

/** A full document from what the model passed. Fragments get a zero-margin shell; SVG fills the
 *  canvas; a document without <base> resolves relative paths against the workspace root. */
export function documentFor(input: { html?: string; svg?: string }, baseHref: string): string {
  const base = `<base href="${baseHref}">`;
  if (input.svg !== undefined) {
    return `<!doctype html><html><head><meta charset="utf-8">${base}<style>html,body{margin:0;height:100%;overflow:hidden}`
      + `body>svg{display:block;width:100vw;height:100vh}</style></head><body>${input.svg}</body></html>`;
  }
  const html = input.html ?? '';
  if (/<html[\s>]/i.test(html)) {
    if (/<base\s/i.test(html)) return html;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : html.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${base}<style>html,body{margin:0}</style></head><body>${html}</body></html>`;
}

/** Runs in the page after load: what a reviewer would notice without looking. */
const LAYOUT_PROBE = `(() => {
  const W = innerWidth, H = innerHeight, out = [];
  const de = document.documentElement;
  if (de.scrollWidth > W + 1 || de.scrollHeight > H + 1) out.push('content is ' + de.scrollWidth + '×' + de.scrollHeight + ', larger than the ' + W + '×' + H + ' canvas — the PNG crops it');
  const label = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '');
  const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  let cut = 0, clipped = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    if ((r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1) && el.children.length === 0 && text(el) && cut < 3) {
      cut++; out.push(label(el) + ' "' + text(el) + '" runs past the canvas edge');
    }
    if ((el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) && /hidden|clip/.test(s.overflow + s.overflowX + s.overflowY) && text(el) && clipped < 3) {
      clipped++; out.push(label(el) + ' "' + text(el) + '" overflows its box and is clipped');
    }
  }
  for (const img of document.images) if (img.complete && img.naturalWidth === 0) out.push('image failed to load: ' + (img.getAttribute('src') || '').slice(0, 120));
  const failedFonts = [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family);
  if (failedFonts.length) out.push('font(s) failed to load, fallback used: ' + [...new Set(failedFonts)].join(', '));
  return out;
})()`;

export function createRenderImageTool(bindings: RenderImageBindings = {}) {
  return tool({
    description:
      'Render HTML or SVG to a PNG file through the local Chrome — banners, OG/social images, '
      + 'posters, cards, diagrams, charts. Write the design as HTML/CSS (or SVG) sized to the canvas; '
      + 'relative paths resolve against the workspace root, so `<img src="assets/logo.png">` works. '
      + 'The result lists layout problems (overflow, text cut off, broken images/fonts) — fix them and '
      + 'render again. Not for photos: those need an image model.',
    inputExamples: [
      { input: { out: 'assets/og-image.png', width: 1200, height: 630, html: '<div style="width:1200px;height:630px;display:grid;place-items:center;background:#0f172a;color:#fff;font:700 72px system-ui">Ship faster</div>' } },
      { input: { out: 'docs/diagram.png', width: 800, height: 400, svg: '<svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="400" fill="#fff"/></svg>' } },
      { input: { out: 'assets/banner.png', file: 'design/banner.html', width: 1500, height: 500 } },
    ],
    inputSchema: z.object({
      out: z.string().describe('Workspace-relative path of the PNG to write (extension forced to .png).'),
      html: z.string().optional().describe('HTML document or fragment to render.'),
      svg: z.string().optional().describe('SVG markup to render, scaled to the canvas.'),
      file: z.string().optional().describe('Workspace .html/.svg file to render instead of inline markup.'),
      width: z.number().optional().describe('Canvas width in CSS px (default 1200).'),
      height: z.number().optional().describe('Canvas height in CSS px (default 630).'),
      scale: z.number().optional().describe('Pixel density 1–3 (default 2: a 1200×630 canvas becomes a 2400×1260 PNG).'),
      transparent: z.boolean().optional().describe('Transparent background where the page paints none.'),
    }),
    toModelOutput: ({ toolCallId, output }) => toolImageOutput(toolCallId, output,
      'The render follows. Check what the layout report cannot: contrast (logo and text against their background), legibility, alignment, balance — fix and render again if anything is off.'),
    execute: async ({ out, html, svg, file, width, height, scale, transparent }, options?: { toolCallId?: string; abortSignal?: AbortSignal }): Promise<string | { error: string }> => {
      if (options?.abortSignal?.aborted) return { error: 'Stopped.' };
      const onAbort = (): void => client?.dispose();
      const sources = [html, svg, file].filter((v) => v !== undefined && v !== '').length;
      if (sources !== 1) return { error: 'Pass exactly one of "html", "svg" or "file".' };
      const W = Math.round(Math.min(Math.max(width ?? 1200, 16), MAX_SIDE));
      const H = Math.round(Math.min(Math.max(height ?? 630, 16), MAX_SIDE));
      const dpr = Math.min(Math.max(scale ?? 2, 1), 3);
      const root = effectiveRootUri().fsPath;
      const outUri = resolveWorkspacePath(out.replace(/\.[A-Za-z0-9]+$/, '') + '.png');

      const chrome = findChromePath(bindings.chromePath);
      if (!chrome) {
        return { error: 'No local Chrome/Edge/Chromium found — install one, or point TIERMUX_CHROME_PATH (or the tiermux.chromePath setting) at the executable. renderImage is disabled until then.' };
      }

      const deadlineAt = Date.now() + (bindings.deadlineMs ?? HARD_DEADLINE_MS);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-render-'));
      let client: CdpPipeClient | undefined;
      try {
        let pageUrl: string;
        if (file) {
          const src = resolveWorkspacePath(file).fsPath;
          if (!fs.existsSync(src)) return { error: `File not found: ${file}` };
          pageUrl = `file://${src.startsWith('/') ? '' : '/'}${src.split(path.sep).map(encodeURIComponent).join('/')}`;
        } else {
          const baseHref = `file://${root.startsWith('/') ? '' : '/'}${root.split(path.sep).map(encodeURIComponent).join('/')}/`;
          const doc = path.join(tmpDir, 'render.html');
          fs.writeFileSync(doc, documentFor({ html, svg }, baseHref));
          pageUrl = `file://${doc.startsWith('/') ? '' : '/'}${doc.split(path.sep).map(encodeURIComponent).join('/')}`;
        }

        client = CdpPipeClient.launch(chrome, [LOCAL_NETWORK_RESOLVER_RULES]);
        // Stop ends the turn; Chrome must not outlive it (dispose rejects every pending send).
        options?.abortSignal?.addEventListener('abort', onAbort, { once: true });
        const page = await withDeadline(client.newPage(), deadlineAt, 'deadline hit while opening a page');
        const sid = page.sessionId;
        const errors: string[] = [];
        const blocked = new Set<string>();
        let loaded = false;
        const dnsCache = new Map<string, boolean>();
        const fileRoots = [path.resolve(root), path.resolve(tmpDir), fs.realpathSync(tmpDir)];

        client.on('Runtime.exceptionThrown', (p, s) => {
          if (s !== sid) return;
          const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
          errors.push(`[exception] ${(d?.exception?.description || d?.text || 'unknown').slice(0, 200)}`);
        });
        client.on('Page.loadEventFired', (_p, s) => { if (s === sid) loaded = true; });
        client.on('Fetch.requestPaused', (p, s) => {
          if (s !== sid) return;
          const requestId = p.requestId as string;
          const target = (p.request as { url?: string } | undefined)?.url ?? '';
          void renderRequestAllowed(target, fileRoots, dnsCache).then((ok) => {
            if (!ok) { try { blocked.add(new URL(target).host || new URL(target).protocol); } catch { /* unparsable */ } }
            return client!.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, sid);
          }).catch(() => undefined);
        });

        for (const m of ['Page.enable', 'Runtime.enable']) {
          await withDeadline(client.send(m, undefined, sid), deadlineAt, `deadline hit at ${m}`);
        }
        await withDeadline(client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid), deadlineAt, 'deadline hit at Fetch.enable');
        await withDeadline(client.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dpr, mobile: false }, sid), deadlineAt, 'deadline hit sizing the canvas');
        if (transparent) {
          await withDeadline(client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sid), deadlineAt, 'deadline hit at the background override');
        }

        const nav = await withDeadline(client.send('Page.navigate', { url: pageUrl }, sid), deadlineAt, 'deadline hit while loading') as { errorText?: string };
        if (nav?.errorText) return { error: `Could not load the page: ${nav.errorText}` };
        await withDeadline((async () => {
          const by = Date.now() + LOAD_TIMEOUT_MS;
          while (!loaded && Date.now() < by) await new Promise((r) => setTimeout(r, 50));
        })(), deadlineAt, 'deadline hit while waiting for load');
        await withDeadline(client.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true }, sid), deadlineAt, 'deadline hit waiting for fonts').catch(() => undefined);
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        const probe = await withDeadline(client.send('Runtime.evaluate', { expression: LAYOUT_PROBE, returnByValue: true }, sid), deadlineAt, 'deadline hit at the layout probe')
          .catch(() => undefined) as { result?: { value?: unknown } } | undefined;
        const issues = Array.isArray(probe?.result?.value) ? (probe!.result!.value as string[]) : [];

        const shot = await withDeadline(client.send('Page.captureScreenshot', {
          format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 }, captureBeyondViewport: false,
        }, sid), deadlineAt, 'deadline hit at the screenshot') as { data: string };
        const bytes = Buffer.from(shot.data, 'base64');
        // The model's copy: JPEG, longest side ≤ PREVIEW_MAX_SIDE device px.
        try {
          const fit = Math.min(1, PREVIEW_MAX_SIDE / Math.max(W, H)) / dpr;
          const preview = await withDeadline(client.send('Page.captureScreenshot', {
            format: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: W, height: H, scale: fit }, captureBeyondViewport: false,
          }, sid), deadlineAt, 'deadline hit at the preview') as { data: string };
          keepToolImage(options?.toolCallId, preview.data);
        } catch { /* no preview — the text result still stands */ }
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(outUri, '..'));
        await vscode.workspace.fs.writeFile(outUri, bytes);
        notifyGraphicRendered(outUri);

        const rel = vscode.workspace.asRelativePath(outUri, false);
        const lines = [`Rendered ${rel} — ${W}×${H} canvas at ${dpr}× (${Math.round(W * dpr)}×${Math.round(H * dpr)} px PNG, ${Math.max(1, Math.round(bytes.length / 1024))} KB).`];
        const all = [...issues, ...errors];
        if (blocked.size) all.push(`blocked requests (policy: data/blob, workspace files, public http(s)): ${[...blocked].join(', ')}`);
        if (all.length) {
          lines.push(`LAYOUT/LOAD ISSUES (${all.length}) — fix and render again:`);
          for (const i of all.slice(0, MAX_ISSUES)) lines.push(`  ✗ ${i}`);
          if (all.length > MAX_ISSUES) lines.push(`  …and ${all.length - MAX_ISSUES} more`);
        } else {
          lines.push('No layout issues detected (nothing overflows the canvas, no clipped text, all images and fonts loaded).');
        }
        return lines.join('\n');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      } finally {
        options?.abortSignal?.removeEventListener('abort', onAbort);
        client?.dispose();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },
  });
}

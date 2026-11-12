// browserVerify — the browser half of frontend verification (design: docs/BROWSER_VERIFY_TOOL.md).
// fetchUrl is static (jsdom) and cannot see a running app; this tool drives the user's own
// headless Chrome over CDP (cdp.ts) and reports the four machine-checkable layers: launch,
// navigation, page JS health (exceptions/console errors) and HTTP status. The screenshot is a
// bonus for vision-capable routed models, gated at CALL time — routing can switch models
// mid-session, and a file a text-only model cannot use is noise. Text verdicts always come
// first: they are the pass/fail signal; the image is soft evidence.
//
// Subresource policy: the top-level URL is user-validated, but a page can ASK for anything. A
// verify run must not become an SSRF/exfil hop, so Fetch interception allows same-origin,
// localhost and data/blob scheme subresources and blocks the rest — the block count lands in the
// verdict so a broken-by-block page is diagnosable.

import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { capToolOutput } from '../capOutput';
import { effectiveRootUri } from '../workspaceRoot';
import { taskRegistryFor } from '../taskRegistry';
import { CdpPipeClient, findChromePath } from './cdp';
import * as dns from 'dns';
import { isHostResolvingToPrivate, isPrivateIp } from './tiermuxWeb/fetcher/safe-fetch';
import { keepToolImage, toolImageOutput } from './toolImages';

const HARD_DEADLINE_MS = 60_000;
const NAV_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_MS = 1_500;
const MAX_SETTLE_MS = 10_000;
const MAX_ERRORS_LISTED = 5;
const ERROR_TEXT_CAP = 400;

export interface BrowserVerifyBindings {
  sessionId?: string;
  requestId?: string;
  /** Call-time probe: does the CURRENTLY routed model accept images? Engine wires this to the
   *  mutable served-model box + catalog lookup; a session-start snapshot would go stale on
   *  failover. Undefined (sub-agent/e2e) → no screenshot. */
  visionCapable?: () => boolean;
  /** Chrome executable override (tests). Falls back to TIERMUX_CHROME_PATH, the
   *  `tiermux.chromePath` setting, then platform candidates. */
  chromePath?: string;
  /** Deadline override (tests want the timeout path fast); default 60 s. */
  deadlineMs?: number;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0', 'host.docker.internal']);

/** Pure on purpose — the policy is the security boundary, so it is unit-tested directly. */
export function subresourceAllowed(url: string, topOrigin: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const origin = u.origin;
  if (origin === topOrigin) return true;
  // Any localhost port/scheme is allowed — the dev stack's API/backend (and an mkcert https
  // frontend) lives next to the dev server. Only for a LOCAL top page: a public page must not
  // reach the user's local services through this browser.
  let topHost = '';
  try { topHost = new URL(topOrigin).hostname; } catch { /* unparsable top → no local reach */ }
  return LOCAL_HOSTS.has(u.hostname) && LOCAL_HOSTS.has(topHost);
}

/** Chrome flags for a PUBLIC top page. WebSocket handshakes skip CDP Fetch interception and
 *  Network.setBlockedURLs (live probe 2026-11-12: a page reached ws://127.0.0.1 twice, once from a
 *  fresh iframe), so the network layer enforces subresourceAllowed's public-page rule: only the
 *  top host connects directly, at the address checked here; everything else, loopback included,
 *  goes to a dead proxy. Exported for e2e. */
export function publicPageChromeArgs(topHost: string, address: string | undefined): string[] {
  const args = ['--proxy-server=http://127.0.0.1:1', `--proxy-bypass-list=<-loopback>;${topHost}`];
  if (address && address !== topHost) args.push(`--host-resolver-rules=MAP ${topHost} ${address.includes(':') ? `[${address}]` : address}`);
  return args;
}

/** Strip query strings and tokens from a URL before it reaches the summary or a filename. */
export function cleanUrlForReport(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

function slugForFilename(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}-${u.pathname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root'}`.slice(0, 60);
  } catch {
    return 'page';
  }
}

/** console arguments arrive as CDP RemoteObjects: primitives carry `value`, an Error or object
 *  only `description` (String() of it printed "[object Object]"). Exported for e2e. */
export function firstArgText(args: unknown[]): string {
  return args.map((a) => {
    if (a === null || a === undefined || typeof a !== 'object') return String(a);
    const o = a as { value?: unknown; description?: string; className?: string; type?: string };
    if ('value' in o) return typeof o.value === 'object' && o.value !== null ? JSON.stringify(o.value) : String(o.value);
    return o.description ?? o.className ?? o.type ?? 'object';
  }).join(' ').slice(0, ERROR_TEXT_CAP);
}

export function createBrowserVerifyTool(bindings: BrowserVerifyBindings = {}) {
  return tool({
    description:
      'Verify a live web page in a real (headless) Chrome: navigation result, HTTP status, page JS '
      + 'exceptions and console errors — the machine-checkable signal a static fetch cannot give. '
      + 'Use it AFTER a UI-affecting change once the dev server is running (runCommand '
      + '{"background":true} keeps it alive); if the errors point at code, fix and re-verify. '
      + 'Not for backend-only changes, and not a substitute for running the project\'s tests. '
      + 'Only same-origin and localhost subresources load; other hosts are blocked and counted.',
    inputExamples: [
      { input: { url: 'http://localhost:3000' } },
      { input: { url: 'http://localhost:5173/pricing', waitMs: 3000 } },
    ],
    inputSchema: z.object({
      url: z.string().url().describe('The page to verify — usually the dev server URL you already know is running.'),
      waitMs: z.number().optional().describe('Extra settle time after load before reading errors/screenshot (default 1500, max 10000).'),
    }),
    toModelOutput: ({ toolCallId, output }) => toolImageOutput(toolCallId, output,
      'The page screenshot follows — check what the verdicts cannot: layout, overlap, contrast, missing or broken visuals.'),
    execute: async ({ url, waitMs }, options?: { toolCallId?: string; abortSignal?: AbortSignal }): Promise<string | { error: string }> => {
      if (options?.abortSignal?.aborted) return { error: 'Stopped.' };
      const onAbort = (): void => client?.dispose();
      const deadlineAt = Date.now() + (bindings.deadlineMs ?? HARD_DEADLINE_MS);
      let client: CdpPipeClient | undefined;
      try {
        // A quiet dev server produces no output and no taskOutput reads — refresh its idle clock
        // so verifying it cannot idle-kill it under our own feet.
        taskRegistryFor(bindings.sessionId).touch();

        let topOrigin: string;
        try {
          topOrigin = new URL(url).origin;
          if (!/^https?:$/.test(new URL(url).protocol)) return { error: 'Only http(s) URLs can be verified.' };
        } catch {
          return { error: `Not a valid URL: ${url}` };
        }
        // Same SSRF line as fetchUrl: loopback is the dev server this tool exists for; any other
        // private/link-local/metadata address (router admin, 169.254.169.254) is refused.
        const topHost = new URL(url).hostname;
        if (!LOCAL_HOSTS.has(topHost) && await isHostResolvingToPrivate(topHost)) {
          return { error: `Refusing to open ${topHost}: it resolves to a private or internal address. Verify the dev server on localhost instead.` };
        }
        const clean = cleanUrlForReport(url);

        // Layer 1 — launch. No browser found is a disabled feature, not a failed verification.
        const chrome = findChromePath(bindings.chromePath);
        if (!chrome) {
          return { error: 'No local Chrome/Edge/Chromium found — install one, or point TIERMUX_CHROME_PATH (or the tiermux.chromePath setting) at the executable. browserVerify is disabled until then.' };
        }
        let chromeArgs: string[] = [];
        if (!LOCAL_HOSTS.has(topHost)) {
          const bare = topHost.replace(/^\[|\]$/g, '');
          const address = await dns.promises.lookup(bare).then((r) => r.address, () => undefined);
          if (address && isPrivateIp(address)) {
            return { error: `Refusing to open ${topHost}: it resolves to a private or internal address. Verify the dev server on localhost instead.` };
          }
          chromeArgs = publicPageChromeArgs(topHost, address);
        }
        client = CdpPipeClient.launch(chrome, chromeArgs);
        // Stop ends the turn; Chrome must not outlive it (dispose rejects every pending send).
        options?.abortSignal?.addEventListener('abort', onAbort, { once: true });

        const page = await withDeadline(client.newPage(), deadlineAt, 'deadline hit while opening a page');
        const sid = page.sessionId;

        // Collectors attached BEFORE navigation (a SPA can error before load completes), plus the
        // subresource policy. Handlers are session-scoped: other targets' noise stays out.
        const exceptions: string[] = [];
        const consoleErrors: string[] = [];
        const logErrors: string[] = [];
        const blocked = new Map<string, number>();
        let httpStatus: number | undefined;
        let httpUrl: string | undefined;
        let loaded = false;
        let loadedAt = 0;
        const startedAt = Date.now();

        client.on('Runtime.exceptionThrown', (p, s) => {
          if (s !== sid) return;
          const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
          const text = d?.exception?.description || d?.text || 'Unknown exception';
          exceptions.push(text.slice(0, ERROR_TEXT_CAP));
        });
        client.on('Runtime.consoleAPICalled', (p, s) => {
          if (s !== sid) return;
          if (p.type === 'error') consoleErrors.push(firstArgText((p.args ?? []) as unknown[]));
        });
        client.on('Log.entryAdded', (p, s) => {
          if (s !== sid) return;
          const e = p.entry as { level?: string; text?: string; url?: string } | undefined;
          if (e?.level !== 'error') return;
          // A favicon 404 is universal dev noise (most dev servers ship none) — surfacing it as
          // a page error sends the agent chasing a ghost instead of the real breakage. Other
          // resource failures (a 500 on /api/…) stay: those are signal.
          if (e.url && /\/favicon\.ico$/.test(e.url) && /404/.test(e.text ?? '')) return;
          logErrors.push((e.url ? `${e.url}: ` : '') + (e.text ?? '').slice(0, ERROR_TEXT_CAP));
        });
        client.on('Network.responseReceived', (p, s) => {
          if (s !== sid) return;
          const r = p.response as { url?: string; status?: number } | undefined;
          if (p.type === 'Document' && r?.status) { httpStatus = r.status; httpUrl = cleanUrlForReport(r.url ?? ''); }
        });
        client.on('Page.loadEventFired', (_p, s) => {
          if (s !== sid) return;
          loaded = true;
          loadedAt = Date.now();
        });
        client.on('Fetch.requestPaused', (p, s) => {
          if (s !== sid) return;
          const req = p.request as { url: string } | undefined;
          const requestId = p.requestId as string;
          const target = req?.url ?? '';
          const allowed = subresourceAllowed(target, topOrigin);
          const fin = allowed
            ? client!.send('Fetch.continueRequest', { requestId }, sid).catch(() => undefined)
            : client!.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid).catch(() => undefined);
          if (!allowed) {
            try { blocked.set(new URL(target).host, (blocked.get(new URL(target).host) ?? 0) + 1); } catch { /* unparsable → already blocked */ }
          }
          void fin;
        });

        for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) {
          await withDeadline(client.send(m, undefined, sid), deadlineAt, `deadline hit at ${m}`);
        }
        await withDeadline(client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid), deadlineAt, 'deadline hit at Fetch.enable');

        // Layer 2 — navigation. Chrome's errorText is the diagnosis (ERR_CONNECTION_REFUSED …).
        let navError: string | undefined;
        try {
          const nav = await withDeadline(
            client.send('Page.navigate', { url }, sid, Math.max(1000, deadlineAt - Date.now() - 1000)),
            deadlineAt,
            'deadline hit while navigating',
          ) as { errorText?: string };
          navError = nav?.errorText;
        } catch (e) {
          navError = e instanceof Error ? e.message : String(e);
        }

        if (navError) {
          return `browserVerify ${clean}\nNAVIGATION: FAILED — ${navError}\nIs the dev server running? (runCommand {"background":true} starts one.)\nHTTP: no response\nCONSOLE: not reached (page never loaded)`;
        }

        // Wait for load, then settle (SPAs keep wiring after loadEventFired).
        const settle = Math.min(Math.max(waitMs && waitMs > 0 ? waitMs : DEFAULT_SETTLE_MS, 0), MAX_SETTLE_MS);
        await withDeadline(
          (async () => {
            const loadBy = Date.now() + NAV_TIMEOUT_MS;
            while (!loaded && Date.now() < loadBy) await new Promise((r) => setTimeout(r, 100));
            await new Promise((r) => setTimeout(r, settle));
          })(),
          deadlineAt,
          'deadline hit while waiting for the page to load',
        );

        // Layer 4 — HTTP status of the document itself.
        const lines: string[] = [`browserVerify ${clean}`];
        lines.push(loaded
          ? `NAVIGATION: ok (loaded in ${((loadedAt - startedAt) / 1000).toFixed(1)}s, settled ${settle}ms)`
          : `NAVIGATION: page never fired load within ${NAV_TIMEOUT_MS / 1000}s (slow SPA or hanging request) — reporting what was captured`);
        lines.push(`HTTP: ${httpStatus !== undefined ? `${httpStatus}${httpStatus >= 400 ? ' (FAILED)' : ''}${httpUrl && httpUrl !== clean ? ` — ${httpUrl}` : ''}` : 'no response recorded'}`);

        // Layer 3 — page JS health.
        const total = exceptions.length + consoleErrors.length + logErrors.length;
        lines.push(`CONSOLE ERRORS: ${total}${total ? ` — first ${Math.min(MAX_ERRORS_LISTED, total)}:` : ''}`);
        for (const e of exceptions.slice(0, MAX_ERRORS_LISTED)) lines.push(`  ✗ [exception] ${e}`);
        for (const e of consoleErrors.slice(0, MAX_ERRORS_LISTED - exceptions.length)) lines.push(`  ✗ [console.error] ${e}`);
        for (const e of logErrors.slice(0, Math.max(0, MAX_ERRORS_LISTED - exceptions.length - consoleErrors.length))) lines.push(`  ✗ [browser] ${e}`);
        if (total > MAX_ERRORS_LISTED) lines.push(`  …and ${total - MAX_ERRORS_LISTED} more (taskOutput-style narrowing: fix the first errors, re-verify)`);

        if (blocked.size > 0) {
          const hosts = [...blocked.entries()].map(([h, n]) => `${h}×${n}`).join(', ');
          lines.push(`BLOCKED SUBRESOURCES: ${[...blocked.values()].reduce((a, b) => a + b, 0)} cross-origin (${hosts}) — policy allows same-origin, localhost and data/blob`);
        }

        // Screenshot — vision models only, decided at call time.
        const vision = bindings.visionCapable?.() === true;
        if (vision) {
          try {
            const shot = await withDeadline(
              client.send('Page.captureScreenshot', { format: 'png' }, sid),
              deadlineAt,
              'deadline hit at the screenshot',
            ) as { data: string };
            const dir = path.join(effectiveRootUri().fsPath, '.tiermux', 'shots');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `verify-${slugForFilename(url)}-${Date.now()}.png`);
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
            lines.push(`SCREENSHOT: ${file} (attached below)`);
            // The model's copy: a JPEG sized for a vision model (~1k tokens), not the full PNG.
            try {
              const metrics = await client.send('Page.getLayoutMetrics', undefined, sid) as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } };
              const vw = metrics.cssVisualViewport?.clientWidth ?? 1280;
              const vh = metrics.cssVisualViewport?.clientHeight ?? 800;
              const jpeg = await withDeadline(client.send('Page.captureScreenshot', {
                format: 'jpeg', quality: 70, clip: { x: 0, y: 0, width: vw, height: vh, scale: Math.min(1, 1024 / Math.max(vw, vh)) },
              }, sid), deadlineAt, 'deadline hit at the preview') as { data: string };
              keepToolImage(options?.toolCallId, jpeg.data);
            } catch { /* the saved file and the text verdicts still stand */ }
          } catch (e) {
            lines.push(`SCREENSHOT: failed — ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          lines.push('SCREENSHOT: skipped — the active model is text-only');
        }

        const verdict = total === 0 && httpStatus !== undefined && httpStatus < 400 && loaded
          ? 'VERDICT: CLEAN — page loaded, HTTP ok, no console errors'
          : 'VERDICT: ISSUES FOUND — see the lines above';
        lines.push(verdict);
        return capToolOutput(lines.join('\n'), 8_000, 'Re-run on the specific route or grep the dev-server log via taskOutput.');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/deadline/.test(msg)) return `browserVerify ${cleanUrlForReport(String(url))}\nVERDICT: TIMED OUT — ${msg}. A page that never settles is itself a finding (hanging request? infinite loader?).`;
        return { error: msg };
      } finally {
        options?.abortSignal?.removeEventListener('abort', onAbort);
        client?.dispose();
      }
    },
  });
}

/** Race a promise against the hard deadline so no stage (a hanging Chrome, a never-loading
 *  page, a stuck screenshot) can hold the tool past its budget. */
export function withDeadline<T>(p: Promise<T>, deadlineAt: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const left = deadlineAt - Date.now();
    if (left <= 0) { reject(new Error(message)); return; }
    const timer = setTimeout(() => reject(new Error(message)), left);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

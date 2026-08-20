
import { tool } from 'ai';
import { z } from 'zod';
import { execFile } from 'child_process';
import * as fs from 'fs';
import { capToolOutput } from '../capOutput';
import { tagExternalContent } from './tiermuxWeb/security';

// checkUrl — the verification-first HTTP checker. Unlike fetchUrl (public-document readability
// extraction), this exists to answer "does my change actually WORK over HTTP?": status code,
// content type, redirect target, and a deterministic marker/expectStatus verdict. Built for
// LOCAL dev servers the agent just started (`http://127.0.0.1:8090/orders`) but works for any
// URL. `render: true` dumps the JS-RENDERED DOM via headless Chrome for SPA pages a plain
// fetch can't see. GET/HEAD only — form POSTs and other mutations go through runCommand's
// curl, where the approval gate covers them.

const FETCH_TIMEOUT_MS = 8_000;
const RENDER_BUDGET_MS = 5_000;
const CONTENT_CHARS = 4_000;

/** Candidate Chrome/Chromium binaries, in order. CHROME_PATH wins if it exists. */
function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    process.platform === 'darwin' ? '/Applications/Chromium.app/Contents/MacOS/Chromium' : undefined,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/local/bin/google-chrome',
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return undefined;
}

function isLocalhost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
  } catch { return false; }
}

/** HTML → title + tag-stripped text, compacted. Cheap and dependency-free; the point is a
 *  marker-checkable rendering, not beautiful extraction (fetchUrl owns that job). */
function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return title ? `[title] ${title}\n${text}` : text;
}

/** Render the body into the reportable content section. */
function renderBody(body: string, contentType: string): string {
  const trimmed = body.trim();
  if (contentType.includes('json') || (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2).slice(0, CONTENT_CHARS); } catch { /* fall through */ }
  }
  if (contentType.includes('html') || /^\s*<(?:!doctype|html)/i.test(trimmed)) {
    return htmlToText(trimmed).slice(0, CONTENT_CHARS);
  }
  return trimmed.slice(0, CONTENT_CHARS);
}

export function createCheckUrlTool() {
  return tool({
    description:
      'Check a URL over HTTP and report a VERDICT — built for verifying your own work against a '
      + 'local dev server you started (e.g. http://127.0.0.1:8090/orders), works for any URL. '
      + 'Returns status code, content type, final URL after redirects, body content (JSON '
      + 'pretty-printed, HTML as text), plus deterministic checks: `marker` (text that MUST '
      + 'appear in the response) and `expectStatus`. Set `render: true` for JavaScript-rendered '
      + 'pages (SPA) to get the DOM after scripts run, via headless Chrome when available. '
      + 'GET/HEAD only — to submit forms or POST to an API, use runCommand with curl.',
    inputSchema: z.object({
      url: z.string().describe('Full http(s) URL to check — typically your local dev server.'),
      expectStatus: z.number().optional().describe('Status code you expect (e.g. 200, 201, 404 for a guard test).'),
      marker: z.string().optional().describe('Text that MUST appear in the response body for the check to pass.'),
      render: z.boolean().optional().describe('Render JavaScript first (headless Chrome) — for SPA pages a plain fetch cannot see.'),
      method: z.enum(['GET', 'HEAD']).optional().describe('HTTP method (default GET). HEAD fetches headers only.'),
    }),
    execute: async ({ url, expectStatus, marker, render, method }: { url: string; expectStatus?: number; marker?: string; render?: boolean; method?: 'GET' | 'HEAD' }): Promise<string> => {
      const lines: string[] = [];
      let body = '';
      let status = 0;
      let contentType = '';
      let finalUrl = url;

      if (render && method !== 'HEAD') {
        const chrome = findChrome();
        if (!chrome) {
          lines.push('RENDER UNAVAILABLE: no headless Chrome/Chromium found (set CHROME_PATH). Falling back to a plain fetch — a JavaScript-rendered page may show empty content.');
        } else {
          // --virtual-time-budget fast-forwards timers so typical SPAs finish mounting.
          const dom = await new Promise<string>((resolve) => {
            execFile(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', `--virtual-time-budget=${RENDER_BUDGET_MS}`, '--dump-dom', url], { timeout: FETCH_TIMEOUT_MS + RENDER_BUDGET_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
              resolve(err ? '' : String(stdout));
            });
          });
          if (dom) {
            body = dom;
            status = 200; // Chrome only dumps DOM on a successful load; real status approximated.
            contentType = 'html (rendered)';
            lines.push(`RENDERED with headless Chrome (${RENDER_BUDGET_MS}ms virtual time).`);
          } else {
            lines.push('RENDER FAILED: Chrome produced no DOM (connection refused or crash?) — see the plain-fetch result below.');
          }
        }
      }

      if (!body || !status) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
          const res = await fetch(url, {
            method: method ?? 'GET',
            signal: ctrl.signal,
            redirect: 'follow',
            headers: { 'cache-control': 'no-cache' },
          });
          clearTimeout(timer);
          status = res.status;
          contentType = res.headers.get('content-type') ?? '';
          finalUrl = res.url || url;
          body = method === 'HEAD' ? '' : await res.text().catch(() => '');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `CHECK FAILED — could not reach ${url}: ${msg}`
            + (url.includes('localhost') || url.includes('127.0.0.1') ? ' (Is the dev server running on that port? See the background-server pattern in your instructions.)' : '');
        }
      }

      lines.unshift(`STATUS ${status}${expectStatus !== undefined ? (status === expectStatus ? ` ✓ (expected ${expectStatus})` : ` ✗ — expected ${expectStatus}`) : ''}`);
      if (finalUrl !== url) lines.push(`Redirected to: ${finalUrl}`);
      lines.push(`Content-Type: ${contentType || '(none)'}`);
      lines.push(`Size: ${body.length} chars`);

      if (marker !== undefined) {
        const found = body.includes(marker);
        lines.push(`MARKER ${found ? 'FOUND ✓' : `NOT FOUND ✗ — "${marker}" does not appear in the response`}`);
      }

      const content = renderBody(body, contentType);
      if (content) lines.push('', '--- content ---', capToolOutput(content, CONTENT_CHARS, '…content truncated.'));

      const report = lines.join('\n');
      // The user's own dev-server output is first-party; only remote responses carry the
      // untrusted-content framing (same rationale as fetchUrl).
      return isLocalhost(url) ? report : tagExternalContent(report);
    },
  });
}

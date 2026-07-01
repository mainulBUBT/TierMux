// Bridge diagnostics: exercises the router proxy (and the OC engine, if up) so we can
// verify the TierMux↔OC wire end-to-end and empirically discover OC's REST/SSE paths
// without guessing. Surfaced via the `tiermux.testOcBridge` command.
//
// Each check records { ok, status?, detail } so the report shows exactly which paths
// OC serves in headless `serve` mode — the missing piece needed before the UI rewire.
import type { OcConnection } from './ocLauncher';

interface CheckResult {
  label: string;
  ok: boolean;
  status?: number;
  detail: string;
}

interface BridgeHandles {
  routerProxy?: { baseURL: string; close(): void };
  ocConnection?: OcConnection;
}

interface FetchResult {
  status: number;
  ok: boolean;
  text: string;
}

async function safeFetch(url: string, init?: RequestInit, timeoutMs = 8000): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    return { status: 0, ok: false, text: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

/** Probe a set of candidate paths and report which ones OC serves (2xx vs 4xx vs error). */
async function probePaths(base: string, headers: Record<string, string>, paths: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const path of paths) {
    const r = await safeFetch(`${base}${path}`, { headers });
    results.push({
      label: `OC GET ${path}`,
      ok: r.ok,
      status: r.status,
      detail: r.ok ? 'served (2xx)' : r.status ? `HTTP ${r.status}` : r.text,
    });
  }
  return results;
}

/**
 * Run the full bridge diagnostic. Pure (no VS Code deps) so it's testable; the command
 * wrapper formats and displays the returned report.
 */
export async function runBridgeDiagnostic(handles: BridgeHandles): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // ---- 1. Router proxy: listing ----
  if (!handles.routerProxy) {
    out.push({ label: 'Router proxy', ok: false, detail: 'not started (extension still activating?)' });
    return out;
  }
  const proxyBase = handles.routerProxy.baseURL.replace(/\/$/, '');
  const modelsRes = await safeFetch(`${proxyBase}/models`);
  let modelCount = 0;
  try {
    const parsed = JSON.parse(modelsRes.text);
    modelCount = Array.isArray(parsed?.data) ? parsed.data.length : 0;
  } catch { /* non-JSON */ }
  out.push({
    label: 'Router proxy  GET /v1/models',
    ok: modelsRes.ok,
    status: modelsRes.status,
    detail: modelsRes.ok ? `${modelCount} models (incl. tiermux/auto|fast|smart)` : modelsRes.text || `HTTP ${modelsRes.status}`,
  });

  // ---- 2. Router proxy: a real routed completion (needs ≥1 enabled model + key) ----
  const chatRes = await safeFetch(`${proxyBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'tiermux/fast',
      stream: false,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    }),
  }, 20000);
  out.push({
    label: 'Router proxy  POST /v1/chat/completions',
    ok: chatRes.ok,
    status: chatRes.status,
    detail: chatRes.ok ? 'routed a completion through TierMux' : chatRes.text || `HTTP ${chatRes.status}`,
  });

  // ---- 3. OC engine (only if the launcher brought it up) ----
  if (!handles.ocConnection) {
    const cache = process.env.HOME
      ? `${process.env.HOME}/Library/Application Support/Code/User/globalStorage/mainul-islam.tiermux/bin/opencode`
      : '<globalStorage>/bin/opencode';
    out.push({
      label: 'OC engine',
      ok: false,
      detail:
        'not running. Likely cause: first-run binary download was killed by the 60s launcher timeout (now bumped to 5 min in v0.1.0-beta.6+). ' +
        `Retry activation; the cached download at ${cache} will be reused. ` +
        'Or set OPENCODE_BIN, run `npm run fetch:binaries`, or install opencode on PATH. ' +
        'See View → Output → "TierMux Engine" for the full download + spawn log.',
    });
    return out;
  }
  const oc = handles.ocConnection;
  const headers = { Authorization: basicAuth(oc.password) };

  out.push(...(await probePaths(oc.baseURL, headers, [
    '/session',                  // list sessions (root API)
    '/app/agents',               // agents (webgui/app path)
    '/agents',                   // agents (root path)
    '/config',                   // config
    '/global/event',             // global SSE stream
    '/session/ses_dummy/message',// prompt endpoint shape (POST would be needed for real)
  ])));

  return out;
}

/** Format the report for an output channel / message. */
export function formatReport(results: CheckResult[]): string {
  const lines = ['TierMux ↔ OpenCode bridge diagnostic', '═'.repeat(48)];
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    const status = r.status ? ` [${r.status}]` : '';
    lines.push(`${mark} ${r.label}${status}`);
    lines.push(`    ${r.detail}`);
  }
  const pass = results.filter((r) => r.ok).length;
  lines.push('─'.repeat(48));
  lines.push(`${pass}/${results.length} checks passed`);
  return lines.join('\n');
}

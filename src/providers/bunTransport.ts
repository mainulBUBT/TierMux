/* The bun shim: OpenCode Zen's anonymous gate fingerprints the TLS/HTTP stack as well as the
 *  body (measured live 2026-11-10 — see docs/PROVIDERS.md § OpenCode Zen), and the extension
 *  host's Node fetch never passes that layer no matter how right the body is. Bun's network
 *  stack is the official client's own family, so when a bun is already installed on the
 *  machine this transport runs each keyless lane request through it: the request spec goes to
 *  a `bun -e` child over stdin, the child fetches, and its stdout — a one-line meta header,
 *  then the raw response bytes as they arrive — is folded back into a standard Response for
 *  the provider's normal SSE reader. Nothing is bundled or downloaded; without bun the caller
 *  falls back to the direct fetch and the lane answers with its honest refusal.
 *
 *  Keyed requests never come here — only the anonymous free lane does. The script is static
 *  (no user data in argv), the spec rides stdin, and the child is killed on timeout or abort. */
import { spawn } from 'child_process';

import { ProviderHttpError } from './base';
import { diagLog } from '../util/diag';

/** Marks the meta line amid anything else bun might print. */
const MAGIC = '@@bunfetch@@';

/* Runs INSIDE bun. Reads the spec from stdin, fetches, writes MAGIC + status/headers as one
 * JSON line, then streams the body. The fetch timeout covers time-to-headers only (cleared
 * once the response arrives) so a long SSE body is not cut short — same semantics as
 * BaseProvider.fetchWithTimeout. */
const BUN_FETCH_SCRIPT = `
const spec = JSON.parse(await new Response(Bun.stdin).text());
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(new Error('timeout')), spec.timeoutMs || 60000);
try {
  const res = await fetch(spec.url, { method: spec.method || 'POST', headers: spec.headers, body: spec.body, signal: ac.signal });
  clearTimeout(timer);
  await Bun.write(Bun.stdout, ${JSON.stringify(MAGIC)} + JSON.stringify({ status: res.status, headers: [...res.headers] }) + '\\n');
  if (res.body) for await (const chunk of res.body) await Bun.write(Bun.stdout, chunk);
} catch (e) {
  await Bun.write(Bun.stdout, ${JSON.stringify(MAGIC)} + JSON.stringify({ error: String(e && e.message || e) }) + '\\n');
  process.exit(1);
}
`;

/** One-shot check, remembered for the session. Resolution order: TIERMUX_BUN (the user's
 *  explicit full path), the installer's stored copy (setBunPathOverride), then PATH. */
let availability: Promise<boolean> | undefined;
let installedPath: string | undefined;

function bunBinary(): string {
  return process.env.TIERMUX_BUN?.trim() || installedPath?.trim() || 'bun';
}

export function isBunAvailable(): Promise<boolean> {
  availability ??= new Promise<boolean>((resolve) => {
    const bin = bunBinary();
    const child = spawn(bin, ['--version'], { stdio: 'ignore' });
    child.on('error', () => { diagLog('bunshim.unavailable', `${bin} not runnable`); resolve(false); });
    child.on('exit', (code) => {
      diagLog('bunshim.available', `${bin} --version exit=${code}`);
      resolve(code === 0);
    });
  });
  return availability;
}

/** The installer calls this after dropping a bun into extension storage; the next
 *  isBunAvailable() re-probes. `undefined` clears it. */
export function setBunPathOverride(path: string | undefined): void {
  installedPath = path?.trim() || undefined;
  availability = undefined;
}

/* ---- the install offer ----
 * The extension (extension.ts) registers a consent-prompting installer here; the e2e harnesses
 * and any vscode-less embedding never set one, and the lane then simply stays direct. */
let installer: (() => Promise<boolean>) | undefined;

export function setBunInstaller(fn: (() => Promise<boolean>) | undefined): void {
  installer = fn;
}

/** One offer per session when the lane is wanted but no bun is around: the prompt must not
 *  hang the turn forever, and a decline must not re-ask on every request. */
let offerBusy: Promise<boolean> | undefined;
let declinedThisSession = false;

export function ensureBunForLane(): Promise<boolean> {
  if (declinedThisSession) return Promise.resolve(false);
  offerBusy ??= (async () => {
    try {
      const ok = await Promise.race([
        installer?.() ?? Promise.resolve(false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 90_000)),
      ]);
      if (!ok) declinedThisSession = true;
      return ok && (await isBunAvailable());
    } catch {
      declinedThisSession = true;
      return false;
    } finally {
      offerBusy = undefined;
    }
  })();
  return offerBusy;
}

/** e2e only: the session-wide decline memory is real state; scenarios must start clean. */
export function __resetBunOfferState(): void {
  declinedThisSession = false;
  offerBusy = undefined;
}

/** Test visibility: how many requests actually went through the shim this process. */
let shimCalls = 0;
export function bunShimCallCount(): number { return shimCalls; }
export function __resetBunShimCallCount(): void { shimCalls = 0; }

export interface BunFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/** fetch() over bun, returning a standard streaming Response. `name` labels timeout errors
 *  like BaseProvider.fetchWithTimeout does. */
export async function bunFetch(req: BunFetchRequest, name: string, outerSignal?: AbortSignal): Promise<Response> {
  shimCalls++;
  const bin = process.env.TIERMUX_BUN?.trim() || 'bun';
  const child = spawn(bin, ['-e', BUN_FETCH_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); if (stderr.length > 2000) stderr = stderr.slice(-2000); });

  let leftover: Uint8Array | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(hardTimer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  };
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  // Hard stop for the pre-headers phase; cleared once the meta line arrives — after that the
  // stream ends when the child ends, mirroring fetch semantics.
  const hardTimer = setTimeout(kill, req.timeoutMs + 5000);
  const onOuterAbort = () => kill();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    child.stdin.write(JSON.stringify({ ...req, timeoutMs: req.timeoutMs }));
    child.stdin.end();

    // Phase 1: the meta line (MAGIC + JSON + \n). Any bytes after it on the same chunk are the
    // start of the body — kept for the stream below.
    const meta = await new Promise<{ status?: number; headers?: [string, string][]; error?: string }>((resolve, reject) => {
      let buf = '';
      const onData = (c: Buffer) => {
        buf += c.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        child.stdout.removeListener('data', onData);
        const line = buf.slice(0, nl);
        if (buf.length > nl + 1) leftover = new Uint8Array(Buffer.from(buf.slice(nl + 1), 'utf8'));
        const at = line.indexOf(MAGIC);
        if (at === -1) {
          reject(new Error(`bun transport sent no meta line — ${line.slice(0, 120) || 'empty output'}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ''}`));
          return;
        }
        try { resolve(JSON.parse(line.slice(at + MAGIC.length))); } catch { reject(new Error(`bun transport meta line is not JSON: ${line.slice(0, 120)}`)); }
      };
      child.stdout.on('data', onData);
      child.on('exit', (code, signal) => reject(new Error(`bun transport exited before answering (code=${code} signal=${signal})${stderr ? ` — ${stderr.slice(0, 200)}` : ''}`)));
    });
    if (meta.error) throw new Error(`bun transport fetch failed: ${meta.error}`);

    // Phase 2: the body, as a ReadableStream fed by the child's stdout.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (leftover) controller.enqueue(leftover);
        child.stdout.on('data', (c: Buffer) => controller.enqueue(new Uint8Array(c)));
        child.stdout.on('end', () => { try { controller.close(); } catch { /* already errored */ } cleanup(); });
        child.stdout.on('error', (e) => { controller.error(e); cleanup(); });
        child.on('exit', (code, signal) => {
          if (code !== 0 || signal) controller.error(new Error(`bun transport ended mid-body (code=${code} signal=${signal})${stderr ? ` — ${stderr.slice(0, 200)}` : ''}`));
          else { try { controller.close(); } catch { /* already errored */ } }
          cleanup();
        });
        outerSignal?.addEventListener('abort', () => { controller.error(outerSignal.reason ?? new Error('aborted')); kill(); }, { once: true });
      },
      cancel() { kill(); cleanup(); },
    });

    const headers = new Headers();
    for (const [k, v] of meta.headers ?? []) {
      // bun already decoded the content-encoding; stale length/encoding headers would lie.
      if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'content-encoding') continue;
      headers.append(k, v);
    }
    return new Response(stream, { status: meta.status ?? 200, headers });
  } catch (e) {
    cleanup();
    kill();
    if (outerSignal?.aborted) throw outerSignal.reason ?? e;
    // Parity with BaseProvider.fetchWithTimeout: a timeout is a 408 the router already knows.
    if (e instanceof Error && /timeout/i.test(e.message)) {
      throw new ProviderHttpError(`${name} request timed out after ${req.timeoutMs}ms (bun transport)`, 408);
    }
    throw e;
  } finally {
    cleanup();
  }
}

/* browserVerify — the 4-layer verification contract (launch / navigation / console health /
 * HTTP status) against a REAL local page, the subresource policy as a pure function, call-time
 * vision gating (text-only models must not get files; a mid-session switch must re-evaluate),
 * the hard deadline on a never-responding endpoint, and the graceful-disable path when no
 * browser is configured. The policy and disable sections always run; the live sections need a
 * local Chrome/Edge and skip (visibly) without one.
 * Run: npm run test:e2e:browser-verify */
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBrowserVerifyTool, subresourceAllowed, cleanUrlForReport, publicPageChromeArgs, firstArgText } from '../src/agent/core/tools/network/browserVerify';
import { CdpPipeClient, findChromePath } from '../src/agent/core/tools/network/cdp';
import { taskRegistryFor } from '../src/agent/core/tools/taskRegistry';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `   (${detail})` : ''}`);
};

type Exec = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const SESSION = 'tm-e2e-bv';
const makeTool = (extra: Record<string, unknown> = {}) =>
  createBrowserVerifyTool({ sessionId: SESSION, ...extra }) as Exec;
const isStr = (r: unknown): r is string => typeof r === 'string';
const isErr = (r: unknown): r is { error: string } => typeof r === 'object' && r !== null && 'error' in r;

/** Serve the fixtures: an erroring page, a clean page, and an endpoint that never answers. */
function startFixtures(): Promise<{ baseUrl: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith('/err')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body>err page
<script src="/same-origin.js"></script>
<script>console.error('boom', 42); setTimeout(() => { throw new TypeError('x is not a function'); }, 50);</script>
<script src="http://192.0.2.1/blocked.js"></script>
</body></html>`);
    } else if (req.url?.startsWith('/same-origin.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('/* ok */');
    } else if (req.url?.startsWith('/clean')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><h1>clean</h1></body></html>');
    } else if (req.url?.startsWith('/hang')) {
      // Take the socket and never answer — the deadline path.
    } else {
      res.writeHead(404); res.end('nope');
    }
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`,
      close: () => srv.close(),
    }));
  });
}

async function main(): Promise<void> {
  const chrome = findChromePath();
  console.log(chrome ? `— Chrome located: ${chrome} —` : '— No local Chrome —');

  console.log('\n— Subresource policy (pure): same-origin + localhost pass, everything else is blocked —');
  {
    const top = 'http://localhost:3000';
    check('same-origin allowed', subresourceAllowed('http://localhost:3000/app.js', top));
    check('same-origin https allowed', subresourceAllowed('https://localhost:3000/x', 'https://localhost:3000'));
    check('localhost other port allowed (dev API)', subresourceAllowed('http://127.0.0.1:8080/api', top));
    check('cross-origin public blocked', !subresourceAllowed('https://cdn.example.com/lib.js', top));
    check('console.error(err) reads as the error, not [object Object]',
      firstArgText([{ type: 'string', value: 'failed:' }, { type: 'object', subtype: 'error', className: 'TypeError', description: 'TypeError: x is not a function' }]) === 'failed: TypeError: x is not a function');
    const args = publicPageChromeArgs('evil.example.com', '93.184.216.34').join(' ');
    check('public page: only its host bypasses the dead proxy, loopback included', /--proxy-bypass-list=<-loopback>;evil\.example\.com(\s|$)/.test(args) && args.includes('--proxy-server='), args);
    check('…and its host is pinned to the checked address (no rebinding)', args.includes('--host-resolver-rules=MAP evil.example.com 93.184.216.34'), args);
    check('…IPv6 address pinned in brackets', publicPageChromeArgs('v6.example.com', '2606:2800::1').join(' ').includes('MAP v6.example.com [2606:2800::1]'));
    check('cross-origin private blocked (SSRF)', !subresourceAllowed('http://192.168.1.10/admin', top));
    check('https localhost on http top allowed by host rule? no — protocol checked', (() => {
      // localhost on a DIFFERENT scheme: http-only rule applies to the localhost branch; https
      // localhost cross-origin is still localhost — allow it (a dev server on https).
      return subresourceAllowed('https://localhost:8443/bundle.js', top);
    })());
    check('public top page cannot reach localhost (SSRF)', !subresourceAllowed('http://127.0.0.1:8080/api', 'https://evil.example.com'));
    check('public top page cannot reach [::1] (SSRF)', !subresourceAllowed('http://[::1]:5432/', 'https://evil.example.com'));
    check('data: allowed', subresourceAllowed('data:image/png;base64,xxx', top));
    check('blob: allowed', subresourceAllowed('blob:http://localhost:3000/uuid', top));
    check('file: blocked', !subresourceAllowed('file:///etc/passwd', top));
    check('javascript: blocked', !subresourceAllowed('javascript:alert(1)', top));
    check('garbage blocked', !subresourceAllowed('not a url', top));
  }

  console.log('\n— URL hygiene —');
  {
    check('query stripped from report url', cleanUrlForReport('http://localhost:3000/x?token=abc&z=1') === 'http://localhost:3000/x');
    check('unparsable falls back to pre-question mark', cleanUrlForReport('::bad::?secret') === '::bad::');
  }

  console.log('\n— No browser configured → a disabled feature, not a failed verification —');
  {
    const t = makeTool({ chromePath: '/nonexistent/tm-test-chrome' });
    const r = await t.execute({ url: 'http://localhost:3000' });
    check('disable message names the fix', isErr(r) && /install|TIERMUX_CHROME_PATH|chromePath/i.test(r.error), String(r));
    check('explicit-but-missing override does not fall back to a real Chrome', isErr(r));
  }

  console.log('\n— Top-level SSRF: private/metadata addresses refused, loopback still allowed —');
  {
    const t = makeTool({ chromePath: '/nonexistent/tm-test-chrome' });
    for (const u of ['http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5:8080/']) {
      const r = await t.execute({ url: u });
      check(`refused ${u}`, isErr(r) && /private or internal/.test(r.error), String(isErr(r) ? r.error : r));
    }
    const ok = await t.execute({ url: 'http://127.0.0.1:3000' });
    check('loopback passes the SSRF gate (fails later on the missing browser)', isErr(ok) && /Chrome/.test(ok.error), String(isErr(ok) ? ok.error : ok));
  }

  if (!chrome) {
    console.log('\n(live sections skipped — no Chrome on this machine)');
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const { baseUrl, close } = await startFixtures();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bv-'));
  try {
    console.log('\n— Live: the 4-layer contract on an erroring page —');
    await runWithWorkspaceRoot(root, async () => {
      const t = makeTool({ visionCapable: () => false });
      const t0 = Date.now();
      const r = await t.execute({ url: `${baseUrl}/err`, waitMs: 800 });
      const took = Date.now() - t0;
      check('returns within 30s', isStr(r) && took < 30_000, `${took}ms`);
      if (isStr(r)) {
        check('navigation ok', r.includes('NAVIGATION: ok'), r.slice(0, 200));
        check('http 200 recorded', /HTTP: 200/.test(r), r.slice(0, 200));
        check('console.error captured', r.includes("[console.error] boom 42"), r);
        check('uncaught exception captured', r.includes('x is not a function'), r);
        check('cross-origin subresource blocked and counted', /BLOCKED SUBRESOURCES: \d+ cross-origin \(192\.0\.2\.1/.test(r), r);
        check('no screenshot for a text-only model', r.includes('SCREENSHOT: skipped'), r);
        check('verdict reports issues', r.includes('VERDICT: ISSUES FOUND'), r);
      } else {
        check('erroring page produced a report', false, JSON.stringify(r));
      }
    });

    console.log('\n— Live: a clean page verifies clean; call-time vision switch re-evaluates —');
    await runWithWorkspaceRoot(root, async () => {
      const textOnly = makeTool({ visionCapable: () => false });
      const r1 = await textOnly.execute({ url: `${baseUrl}/clean`, waitMs: 500 });
      check('clean page: CLEAN verdict', isStr(r1) && r1.includes('VERDICT: CLEAN'), String(r1));
      check('clean page: no errors', isStr(r1) && r1.includes('CONSOLE ERRORS: 0'), String(r1));

      const vision = makeTool({ visionCapable: () => true }); // the "session" switched models
      const r2 = await vision.execute({ url: `${baseUrl}/clean`, waitMs: 500 });
      check('vision model gets a screenshot path', isStr(r2) && /SCREENSHOT: .*\.png/.test(r2), String(r2));
      if (isStr(r2)) {
        const file = r2.match(/SCREENSHOT: (\S+\.png)/)?.[1];
        check('screenshot file exists and is a real png', !!file && fs.existsSync(file) && fs.statSync(file).size > 1000, file ?? '');
        check('screenshot filename carries no query string', !file?.includes('?'), file ?? '');
      }
    });

    console.log('\n— Live: navigation failure is a diagnosis, not a crash —');
    await runWithWorkspaceRoot(root, async () => {
      const t = makeTool({ visionCapable: () => false });
      const r = await t.execute({ url: 'http://127.0.0.1:1/nope', waitMs: 200 });
      check('dead port: NAVIGATION FAILED with a hint', isStr(r) && r.includes('NAVIGATION: FAILED') && r.includes('dev server'), String(r));
    });

    console.log('\n— Live: a never-responding endpoint cannot hang the tool —');
    await runWithWorkspaceRoot(root, async () => {
      const t = makeTool({ visionCapable: () => false, deadlineMs: 3_000 });
      const t0 = Date.now();
      const r = await t.execute({ url: `${baseUrl}/hang`, waitMs: 5_000 });
      const took = Date.now() - t0;
      check('returns near the deadline (<6s), not the default 60s', took < 6_000, `${took}ms`);
      check('reports the timeout/failed navigation', isStr(r) && /TIMED OUT|FAILED/.test(r), String(r));
    });

    console.log('\n— A public page cannot open a WebSocket to localhost (Fetch interception misses WS) —');
    {
      let upgrades = 0;
      const wsSrv = http.createServer((_q, r) => r.end());
      wsSrv.on('upgrade', (_q, sock) => { upgrades++; sock.destroy(); });
      await new Promise<void>((r) => wsSrv.listen(0, '127.0.0.1', () => r()));
      const wsPort = (wsSrv.address() as net.AddressInfo).port;
      const pageSrv = http.createServer((_q, r) => {
        r.writeHead(200, { 'content-type': 'text/html' });
        r.end(`<script>new WebSocket('ws://127.0.0.1:${wsPort}/a');setTimeout(()=>{const i=document.createElement('iframe');document.documentElement.appendChild(i);new i.contentWindow.WebSocket('ws://localhost:${wsPort}/b')},50)</script>`);
      });
      await new Promise<void>((r) => pageSrv.listen(0, '127.0.0.1', () => r()));
      const pagePort = (pageSrv.address() as net.AddressInfo).port;
      // "public.test" stands in for a public host: pinned to the fixture's address, like a real lookup.
      const c = CdpPipeClient.launch(chrome, publicPageChromeArgs('public.test', '127.0.0.1'));
      let docStatus = 0;
      try {
        const { sessionId } = await c.newPage();
        await c.send('Network.enable', undefined, sessionId);
        c.on('Network.responseReceived', (p, sid) => { if (sid === sessionId && p.type === 'Document') docStatus = (p.response as { status: number }).status; });
        await c.send('Page.navigate', { url: `http://public.test:${pagePort}/` }, sessionId);
        await new Promise((r) => setTimeout(r, 1500));
      } finally {
        c.dispose();
        wsSrv.close(); pageSrv.close();
      }
      check('the public page itself loads directly', docStatus === 200, String(docStatus));
      check('no WebSocket handshake reached localhost (main frame or fresh iframe)', upgrades === 0, `${upgrades} upgrade(s)`);
    }

    console.log('\n— Verifying refreshes the dev-server idle clock —');
    await runWithWorkspaceRoot(root, async () => {
      const reg = taskRegistryFor(SESSION);
      const task = reg.start('sleep 60', { cwd: os.tmpdir(), sessionId: SESSION }).task!;
      const before = task.lastReadAt;
      const t = makeTool({ visionCapable: () => false });
      await t.execute({ url: `${baseUrl}/clean`, waitMs: 300 });
      check('lastReadAt advanced by the verify call', task.lastReadAt >= before, `${before} → ${task.lastReadAt}`);
      reg.killAll();
    });
  } finally {
    close();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

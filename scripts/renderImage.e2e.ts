/* renderImage (2026-11-12): HTML/SVG → PNG through the local Chrome. Pins the request policy (the
 * markup is model-written: no loopback, no private hosts, no files outside the workspace), the
 * document wrapping, and — with a real Chrome — the PNG size and the layout-issue report the
 * model relies on because it cannot see the pixels. Skips the live half visibly without Chrome.
 * Run: npm run test:e2e:render-image */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createRenderImageTool, renderRequestAllowed, documentFor } from '../src/agent/core/tools/network/renderImage';
import { findChromePath } from '../src/agent/core/tools/network/cdp';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { toRouterMessages, withoutToolImages, TOOL_IMAGE_LEAD } from '../src/agent/core/routerProvider';
import { estimateTokens } from '../src/agent/core/compact';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d && !c ? `   (${d})` : ''}`); if (!c) bad++; };
type Exec = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const isErr = (r: unknown): r is { error: string } => typeof r === 'object' && r !== null && 'error' in r;

/** Width/height from a PNG's IHDR chunk. */
function pngSize(file: string): { w: number; h: number } | undefined {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return undefined;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-render-ws-')));

  console.log('— Request policy: model-written markup never reaches loopback, private hosts or outside files —');
  {
    const dns = new Map<string, boolean>();
    const roots = [root];
    ok('data: allowed', await renderRequestAllowed('data:image/png;base64,xx', roots, dns));
    ok('workspace file allowed', await renderRequestAllowed(`file://${root}/assets/logo.png`, roots, dns));
    ok('file outside the workspace blocked', !(await renderRequestAllowed('file:///etc/passwd', roots, dns)));
    ok('sibling dir with the same prefix blocked', !(await renderRequestAllowed(`file://${root}-evil/x.png`, roots, dns)));
    ok('localhost blocked', !(await renderRequestAllowed('http://localhost:3000/api', roots, dns)));
    ok('127.0.0.1 blocked', !(await renderRequestAllowed('http://127.0.0.1:8080/', roots, dns)));
    ok('private LAN blocked', !(await renderRequestAllowed('http://192.168.1.1/', roots, dns)));
    ok('cloud metadata blocked', !(await renderRequestAllowed('http://169.254.169.254/latest', roots, dns)));
    ok('public IP allowed (web fonts/images)', await renderRequestAllowed('https://8.8.8.8/font.woff2', roots, dns));
    ok('javascript: blocked', !(await renderRequestAllowed('javascript:alert(1)', roots, dns)));
  }

  console.log('\n— Document wrapping —');
  {
    const frag = documentFor({ html: '<h1>Hi</h1>' }, 'file:///ws/');
    ok('a fragment gets a doctype, zero margin and the workspace <base>', frag.startsWith('<!doctype html>') && frag.includes('margin:0') && frag.includes('<base href="file:///ws/">') && frag.includes('<h1>Hi</h1>'));
    const full = documentFor({ html: '<html><head><title>x</title></head><body>b</body></html>' }, 'file:///ws/');
    ok('a full document gets <base> injected into its head', /<head><base href="file:\/\/\/ws\/"><title>/.test(full), full);
    const own = '<html><head><base href="https://cdn.example/"></head><body></body></html>';
    ok('an existing <base> is respected', documentFor({ html: own }, 'file:///ws/') === own);
    const svg = documentFor({ svg: '<svg viewBox="0 0 10 10"></svg>' }, 'file:///ws/');
    ok('svg is scaled to the canvas', svg.includes('body>svg{display:block;width:100vw;height:100vh}') && svg.includes('<svg viewBox'));
  }

  console.log('\n— Arguments —');
  {
    const t = createRenderImageTool({ chromePath: '/nonexistent/chrome' }) as Exec;
    const none = await runWithWorkspaceRoot(root, () => t.execute({ out: 'a.png' }));
    ok('no source is refused', isErr(none) && /exactly one/.test(none.error));
    const two = await runWithWorkspaceRoot(root, () => t.execute({ out: 'a.png', html: '<p>', svg: '<svg/>' }));
    ok('two sources are refused', isErr(two) && /exactly one/.test(two.error));
    const noChrome = await runWithWorkspaceRoot(root, () => t.execute({ out: 'a.png', html: '<p>x</p>' }));
    ok('no browser → a disabled feature with the fix named', isErr(noChrome) && /TIERMUX_CHROME_PATH|chromePath/.test(noChrome.error));
  }

  console.log('\n— Tool images reach vision models only (router), and never bloat the estimate —');
  {
    const img = (id: string) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'renderImage',
      output: { type: 'content', value: [{ type: 'text', text: `Rendered ${id}.png` }, { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'QUJD'.repeat(5000) } }] } }] });
    const call = (id: string) => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'renderImage', input: {} }] });
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'make a banner' }] }, call('a'), img('a'), call('b'), img('b'), call('c'), img('c')] as never;
    const msgs = toRouterMessages(prompt);
    const tool = msgs.find((m) => m.role === 'tool');
    ok('the tool message carries the text only', tool?.content === 'Rendered a.png');
    const imageMsgs = msgs.filter((m) => m.role === 'user' && Array.isArray(m.content));
    ok('the newest two images ride as user image messages', imageMsgs.length === 2
      && imageMsgs.every((m) => (m.content as Array<{ type: string }>).some((b) => b.type === 'image_url')), JSON.stringify(imageMsgs.map((m) => (m.content as Array<{ type: string }>).map((b) => b.type))));
    ok('the oldest image becomes a note', msgs.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(TOOL_IMAGE_LEAD) && /omitted/.test(m.content)));
    const order = msgs.map((m) => m.role).join(',');
    ok('each image message follows its tool result', order === 'user,assistant,tool,user,assistant,tool,user,assistant,tool,user', order);
    const text = withoutToolImages(msgs);
    ok('a text-only candidate gets no pixels', !JSON.stringify(text).includes('image_url') && text.filter((m) => m.role === 'user' && typeof m.content === 'string' && /cannot see images/.test(m.content)).length === 2);
    ok('a user-attached image is not touched by the strip', JSON.stringify(withoutToolImages([{ role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image_url', image_url: { url: 'data:x' } }] }] as never)).includes('image_url'));
    const est = estimateTokens(prompt);
    ok('three 20 KB images estimate as ~1k tokens each, not as base64 text', est < 5_000, String(est));
  }

  const chrome = findChromePath();
  if (!chrome) {
    console.log('\nSKIP  live renders (no local Chrome/Edge/Chromium)');
  } else {
    console.log('\n— Live renders through the local Chrome —');
    const t = createRenderImageTool() as Exec;
    const run = (args: unknown) => runWithWorkspaceRoot(root, () => t.execute(args));

    const clean = await run({ out: 'out/card.jpg', width: 400, height: 200, html: '<div style="width:400px;height:200px;display:grid;place-items:center;background:#0f172a;color:#fff;font:700 32px system-ui">Hello</div>' });
    const cardPng = path.join(root, 'out', 'card.png');
    ok('writes the PNG (extension forced to .png, folders created)', typeof clean === 'string' && fs.existsSync(cardPng), JSON.stringify(clean));
    ok('PNG is canvas × scale 2 (800×400)', JSON.stringify(pngSize(cardPng)) === JSON.stringify({ w: 800, h: 400 }), JSON.stringify(pngSize(cardPng)));
    ok('a clean design reports no issues', typeof clean === 'string' && /No layout issues detected/.test(clean), String(clean));

    const t2 = createRenderImageTool() as Exec & { toModelOutput: (o: { toolCallId: string; output: unknown }) => { type: string; value: Array<{ type: string; mediaType?: string; data?: { data: string } }> } };
    const withId = await runWithWorkspaceRoot(root, () => t2.execute({ out: 'out/wide.png', width: 1600, height: 900, html: '<div style="width:1600px;height:900px;background:#fff">x</div>' }, { toolCallId: 'call-1' }));
    const mo = t2.toModelOutput({ toolCallId: 'call-1', output: withId });
    const part = mo.value?.find?.((p) => p.type === 'file');
    const jpeg = part?.data?.data ? Buffer.from(part.data.data, 'base64') : Buffer.alloc(0);
    ok('the model gets text + a JPEG preview', mo.type === 'content' && part?.mediaType === 'image/jpeg' && jpeg[0] === 0xff && jpeg[1] === 0xd8, JSON.stringify(mo).slice(0, 200));
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    const pw = sof > 0 ? jpeg.readUInt16BE(sof + 7) : 0;
    ok('the preview is sized for a model (longest side ≤ 1024)', pw > 0 && pw <= 1024, String(pw));
    ok('the preview is taken once', t2.toModelOutput({ toolCallId: 'call-1', output: withId }).type === 'text');

    const scale1 = await run({ out: 'out/s1.png', width: 300, height: 100, scale: 1, svg: '<svg viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="100" fill="#e11d48"/></svg>' });
    ok('svg renders at scale 1 (300×100)', typeof scale1 === 'string' && JSON.stringify(pngSize(path.join(root, 'out', 's1.png'))) === JSON.stringify({ w: 300, h: 100 }), String(scale1));

    const overflow = await run({ out: 'out/over.png', width: 300, height: 100, html: '<h1 style="margin:0;font:700 60px system-ui;white-space:nowrap">This headline is far too long for the canvas</h1>' });
    ok('text running past the canvas is reported', typeof overflow === 'string' && /LAYOUT\/LOAD ISSUES/.test(overflow) && /(larger than the 300×100 canvas|runs past the canvas edge)/.test(overflow), String(overflow));

    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.copyFileSync(cardPng, path.join(root, 'assets', 'logo.png'));
    const local = await run({ out: 'out/local.png', width: 200, height: 100, html: '<img src="assets/logo.png" width="200" height="100" style="display:block">' });
    ok('a workspace-relative image loads (no broken-image issue)', typeof local === 'string' && !/image failed to load/.test(local) && /No layout issues/.test(local), String(local));
    const broken = await run({ out: 'out/broken.png', width: 200, height: 100, html: '<img src="assets/missing.png" width="50" height="50">' });
    ok('a missing image is reported', typeof broken === 'string' && /image failed to load: assets\/missing\.png/.test(broken), String(broken));
    const ssrf = await run({ out: 'out/ssrf.png', width: 200, height: 100, html: '<img src="http://127.0.0.1:9/x.png" width="10" height="10">' });
    ok('a loopback request is blocked and named', typeof ssrf === 'string' && /blocked requests.*127\.0\.0\.1/.test(ssrf), String(ssrf));
    {
      let upgrades = 0;
      const wsSrv = http.createServer((_q, r) => r.end());
      wsSrv.on('upgrade', (_q, sock) => { upgrades++; sock.destroy(); });
      await new Promise<void>((r) => wsSrv.listen(0, '127.0.0.1', () => r()));
      const port = (wsSrv.address() as { port: number }).port;
      await run({ out: 'out/ws.png', width: 200, height: 100, html: `<script>new WebSocket('ws://127.0.0.1:${port}/a');new WebSocket('ws://localhost:${port}/b')</script><p>x</p>` });
      await new Promise((r) => setTimeout(r, 300));
      wsSrv.close();
      ok('a WebSocket to loopback never connects (Fetch interception misses WS)', upgrades === 0, `${upgrades} upgrade(s)`);
    }

    fs.mkdirSync(path.join(root, 'design'), { recursive: true });
    fs.writeFileSync(path.join(root, 'design', 'banner.html'), '<!doctype html><html><body style="margin:0"><img src="../assets/logo.png" width="300" height="100" style="display:block"></body></html>');
    const fromFile = await run({ out: 'out/banner.png', file: 'design/banner.html', width: 300, height: 100 });
    ok('file mode renders with paths relative to that file', typeof fromFile === 'string' && /No layout issues/.test(fromFile), String(fromFile));

    const transparent = await run({ out: 'out/icon.png', width: 64, height: 64, transparent: true, svg: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="20" fill="#2563eb"/></svg>' });
    ok('transparent render succeeds', typeof transparent === 'string' && fs.existsSync(path.join(root, 'out', 'icon.png')), String(transparent));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

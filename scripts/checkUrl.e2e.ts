/* checkUrl — the verification-first HTTP checker (src/agent/core/tools/network/checkUrl.ts).
 *
 * The scenario it exists for: the agent added an "orders" feature to a web project, started
 * the dev server in the background, and must now prove the feature works over HTTP — status,
 * content, and a deterministic marker verdict — without the user opening a browser.
 *
 * Spins a REAL local http server on an ephemeral port (html page, JSON endpoint, 404,
 * redirect, plus a JS-render check path) and drives the tool directly.
 *
 * Run: npm run test:e2e:check-url
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCheckUrlTool } from '../src/agent/core/tools/network/checkUrl';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const HTML_PAGE = '<!doctype html><html><head><title>Orders</title></head><body><h1>Order placed</h1><p>Your order #42 was created.</p></body></html>';
const JSON_BODY = JSON.stringify({ ok: true, order: { id: 42, total: 990 } });

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === '/' ) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_PAGE); return; }
    if (req.url === '/api/orders/42') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON_BODY); return; }
    if (req.url === '/gone') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not here'); return; }
    if (req.url === '/old-orders') { res.writeHead(302, { location: '/' }); res.end(); return; }
    if (req.url === '/spa') {
      // A "JS-rendered" page: the marker only exists in the DOM after the script runs —
      // built by concatenation so the literal string is not present in the static response.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><div id="app">loading</div><script>document.getElementById("app").textContent="Order " + "placed via JS";</script></body></html>');
      return;
    }
    res.writeHead(500); res.end('err');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const t = createCheckUrlTool() as any;

  console.log('— HTML page: status, content, marker verdicts —');
  {
    const out: string = await t.execute({ url: `${base}/`, marker: 'Order placed' }, { toolCallId: 'c1' });
    ok('status 200 reported with content-type', out.includes('STATUS 200') && out.includes('text/html'));
    ok('title extracted', out.includes('[title] Orders'));
    ok('marker FOUND verdict on present marker', out.includes('MARKER FOUND ✓'));
    ok('local response is NOT wrapped as external content', !out.includes('external-content'));
  }
  {
    const out: string = await t.execute({ url: `${base}/`, marker: 'Refund issued' }, { toolCallId: 'c2' });
    ok('marker NOT FOUND verdict on missing marker', out.includes('MARKER NOT FOUND ✗') && out.includes('Refund issued'));
  }
  {
    const out: string = await t.execute({ url: `${base}/gone`, expectStatus: 404 }, { toolCallId: 'c3' });
    ok('expectStatus 404 passes on a real 404', out.includes('STATUS 404 ✓ (expected 404)'));
  }
  {
    const out: string = await t.execute({ url: `${base}/`, expectStatus: 201 }, { toolCallId: 'c4' });
    ok('expectStatus mismatch is flagged', out.includes('✗ — expected 201'));
  }

  console.log('\n— redirect + JSON —');
  {
    const out: string = await t.execute({ url: `${base}/old-orders` }, { toolCallId: 'c5' });
    ok('redirect followed and final URL reported', out.includes(`Redirected to: ${base}/`) && out.includes('STATUS 200'));
  }
  {
    // Marker check runs against the RAW body (compact JSON) while the display pretty-prints.
    const out: string = await t.execute({ url: `${base}/api/orders/42`, marker: '"total":990' }, { toolCallId: 'c6' });
    ok('JSON pretty-printed with marker check', out.includes('"order"') && out.includes('"total": 990') && out.includes('MARKER FOUND ✓'));
  }

  console.log('\n— unreachable server: actionable message —');
  {
    const out: string = await t.execute({ url: 'http://127.0.0.1:1/', }, { toolCallId: 'c7' });
    ok('connection refused produces the dev-server hint', out.includes('CHECK FAILED') && out.includes('dev server running'));
  }

  console.log('\n— render:true —');
  {
    const out: string = await t.execute({ url: `${base}/spa`, marker: 'Order placed via JS', render: true }, { toolCallId: 'c8' });
    const rendered = out.includes('Order placed via JS') && out.includes('MARKER FOUND ✓');
    const fallback = out.includes('RENDER UNAVAILABLE') || out.includes('RENDER FAILED');
    ok('JS-only marker found via headless render, or a clean fallback message', rendered || (fallback && out.includes('loading')), out.slice(0, 90).replace(/\n/g, ' '));
    // Static fetch of the same page must NOT find the marker — proves the render path mattered.
    if (rendered) {
      const staticOut: string = await t.execute({ url: `${base}/spa`, marker: 'Order placed via JS' }, { toolCallId: 'c9' });
      ok('the same page via plain fetch misses the JS marker (render really renders)', staticOut.includes('MARKER NOT FOUND'));
    }
  }

  server.close();
  console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

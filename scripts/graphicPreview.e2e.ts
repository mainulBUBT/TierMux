/* graphicPreview (2026-11-12): the pure half of the live graphic preview — which files open in it,
 * the canvas a source pins itself to, and the srcdoc it renders (workspace <base>, SVG scaled).
 * Run: npm run test:e2e:graphic-preview */
import { previewKind, detectCanvas, previewDocument } from '../src/preview/graphicDoc';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d && !c ? `   (${d})` : ''}`); if (!c) bad++; };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('— Previewable files —');
ok('png/jpg/jpeg/webp are images', ['a.png', 'b.JPG', 'c.jpeg', 'd.webp'].every((f) => previewKind(f) === 'image'));
ok('html/htm/svg are live sources', ['design/og.html', 'x.htm', 'logo.SVG'].every((f) => previewKind(f) === 'source'));
ok('other files are not previewable', ['a.ts', 'README.md', 'html'].every((f) => previewKind(f) === undefined));
ok('a dot in the directory does not count', previewKind('/ws/site.html/notes') === undefined);

console.log('\n— Canvas detection —');
ok('root inline style px width/height',
  eq(detectCanvas('<div style="width:1200px;height:630px;display:grid">x</div>'), { width: 1200, height: 630 }));
ok('CSS rule on the root class', eq(detectCanvas('<style>html,body{margin:0}.card{ width: 1080px; height: 1920px; overflow:hidden }</style><div class="card"></div>'), { width: 1080, height: 1920 }));
ok('max-width/min-height do not count', detectCanvas('<div style="max-width:1200px;min-height:630px"></div>') === undefined);
ok('a small icon does not pass for the canvas', eq(detectCanvas('<style>img{width:48px;height:48px}</style><div style="width:1600px;height:900px"></div>'), { width: 1600, height: 900 }));
ok('the first full declaration wins', eq(detectCanvas('<div style="width:1280px;height:720px"><p style="width:400px;height:200px"></p></div>'), { width: 1280, height: 720 }));
ok('no px size → undefined (preview falls back to the default)', detectCanvas('<h1>Hi</h1>') === undefined);
ok('svg width/height attributes', eq(detectCanvas('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"></svg>', true), { width: 800, height: 400 }));
ok('svg viewBox when no width/height', eq(detectCanvas('<svg viewBox="0 0 1200 630"></svg>', true), { width: 1200, height: 630 }));
ok('svg percentage size falls back to viewBox', eq(detectCanvas('<svg width="100%" height="100%" viewBox="0 0 512 512"></svg>', true), { width: 512, height: 512 }));

console.log('\n— Preview document —');
const base = 'https://file+.vscode-resource.vscode-cdn.net/ws/design/';
const frag = previewDocument('<h1>Hi</h1>', false, base);
ok('a fragment gets a doctype, zero margin and the <base>', frag.startsWith('<!doctype html>') && frag.includes(`<base href="${base}">`) && frag.includes('margin:0') && frag.includes('<h1>Hi</h1>'));
const full = previewDocument('<!doctype html><html lang="en"><head><title>x</title></head><body>b</body></html>', false, base);
ok('a full document gets <base> first in its head', full.includes(`<head><base href="${base}"><title>`), full);
const headless = previewDocument('<html><body>b</body></html>', false, base);
ok('a document without <head> gets one', headless.includes(`<html><head><base href="${base}"></head><body>`), headless);
const own = '<html><head><base href="https://cdn.example/"></head><body></body></html>';
ok('an existing <base> is respected', previewDocument(own, false, base) === own);
const svg = previewDocument('<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"></svg>', true, base);
ok('svg is scaled to the canvas without its xml prolog', svg.includes('body>svg{display:block;width:100vw;height:100vh}') && svg.includes('<svg viewBox') && !svg.includes('<?xml'));
ok('a quote in the base href cannot break out of the attribute', previewDocument('x', false, 'https://a/"b/').includes('href="https://a/&quot;b/"'));

console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
process.exit(bad ? 1 : 0);

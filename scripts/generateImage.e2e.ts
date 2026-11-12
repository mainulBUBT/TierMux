/* generateImage (2026-11-12): photos/illustrations through AI Horde's anonymous queue. Pins the
 * request body (anonymous limits: ≤ 1024×1024, multiples of 64, SFW), status parsing (faulted,
 * impossible, censored), the out-path/format plan, overwrite refusal, cancel-on-abort/deadline and
 * the honest error strings — all against a mocked fetch. LIVE=1 adds one real draft generation.
 * Run: npm run test:e2e:generate-image */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGenerateImageTool, buildHordeRequest, sizeFor, parseCheck, pickGeneration, sniffImage, planOut } from '../src/agent/core/tools/network/generateImage';
import { findChromePath } from '../src/agent/core/tools/network/cdp';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d && !c ? `   (${d})` : ''}`); if (!c) bad++; };
type Exec = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
type WithOutput = Exec & { toModelOutput: (o: { toolCallId: string; output: unknown }) => { type: string; value: unknown } };
const isErr = (r: unknown): r is { error: string } => typeof r === 'object' && r !== null && 'error' in r;

const WEBP_1PX = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }
/** Scripted Horde: `checks` are returned in order (the last repeats), then status. */
function mockHorde(opts: { submit?: { status: number; json: unknown }; checks?: unknown[]; status?: unknown }) {
  const calls: Call[] = [];
  let i = 0;
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (url.endsWith('/generate/async')) return opts.submit ? json(opts.submit.status, opts.submit.json) : json(202, { id: 'job-1', kudos: 6 });
    if (url.includes('/generate/check/')) { const c = opts.checks ?? [{ done: true }]; return json(200, c[Math.min(i++, c.length - 1)]); }
    if (url.includes('/generate/status/')) return method === 'DELETE' ? json(200, {}) : json(200, opts.status ?? { done: true, generations: [{ img: WEBP_1PX, censored: false, model: 'Deliberate', seed: '42' }] });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return { f, calls, cancelled: () => calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/generate/status/job-1')) };
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-genimg-ws-')));
  const noChrome = '/nonexistent/chrome';

  console.log('— Sizes stay inside the anonymous limits —');
  for (const q of ['draft', 'standard'] as const) {
    for (const a of ['landscape', 'square', 'portrait'] as const) {
      const [w, h] = sizeFor(a, q);
      ok(`${q}/${a} ${w}×${h}: ≤ 1024², multiples of 64`, w * h <= 1024 * 1024 && w % 64 === 0 && h % 64 === 0);
    }
  }
  ok('default is standard landscape 1024×576', sizeFor().join('×') === '1024×576');

  console.log('\n— Request body —');
  {
    const b = buildHordeRequest({ prompt: 'a lighthouse ### sneaky', negativePrompt: 'people' }) as { prompt: string; params: Record<string, unknown>; models: string[]; nsfw: boolean; censor_nsfw: boolean; r2: boolean };
    ok('negative prompt rides after ###, with the defaults', /^a lighthouse\s+sneaky ### people, watermark/.test(b.prompt) && b.prompt.split('###').length === 2, b.prompt);
    ok('SFW and censored', b.nsfw === false && b.censor_nsfw === true);
    ok('standard → AlbedoBase XL, 30 steps, n=1', b.models[0] === 'AlbedoBase XL (SDXL)' && b.params.steps === 30 && b.params.n === 1 && b.params.width === 1024 && b.params.height === 576);
    const d = buildHordeRequest({ prompt: 'x', quality: 'draft', aspect: 'square' }) as { models: string[]; params: Record<string, unknown> };
    ok('draft → SD1.5 at 512²', d.models[0] === 'Deliberate' && d.params.width === 512 && d.params.height === 512);
  }

  console.log('\n— Status parsing —');
  ok('faulted', parseCheck({ faulted: true, done: false }).kind === 'failed');
  ok('done', parseCheck({ done: true }).kind === 'done');
  ok('impossible', parseCheck({ done: false, is_possible: false }).kind === 'failed');
  const w = parseCheck({ done: false, is_possible: true, queue_position: 3, wait_time: 40 });
  ok('waiting carries queue position and wait', w.kind === 'waiting' && w.queuePosition === 3 && w.waitSeconds === 40);
  const cen = pickGeneration({ generations: [{ img: 'x', censored: true }] });
  ok('censored → error', 'error' in cen && /censored/.test(cen.error));
  ok('no generations → error', 'error' in pickGeneration({ generations: [] }));
  const g = pickGeneration({ generations: [{ img: 'https://r2/x.webp', censored: false, model: 'M', seed: '1' }] });
  ok('generation picked', !('error' in g) && g.img === 'https://r2/x.webp' && g.model === 'M');

  console.log('\n— Bytes and out paths —');
  ok('sniff webp', sniffImage(Buffer.from(WEBP_1PX, 'base64')) === 'webp');
  ok('sniff png', sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])) === 'png');
  ok('sniff jpeg', sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) === 'jpeg');
  ok('sniff junk', sniffImage(Buffer.from('<html>')) === undefined);
  ok('.png with Chrome stays png', JSON.stringify(planOut('a/b.png', true)) === JSON.stringify({ path: 'a/b.png', format: 'png' }));
  const p2 = planOut('a/b.png', false);
  ok('.png without Chrome → .webp with a note', p2.path === 'a/b.webp' && p2.format === 'webp' && !!p2.note);
  ok('.jpeg with Chrome → jpeg', planOut('x.jpeg', true).format === 'jpeg' && planOut('x.jpeg', true).path === 'x.jpeg');
  ok('.webp kept', planOut('x.webp', false).path === 'x.webp');
  ok('no extension → .webp', planOut('img/hero', true).path === 'img/hero.webp');
  ok('.gif → .webp', planOut('x.gif', true).path === 'x.webp');

  const run = (t: Exec, args: unknown, o?: unknown) => runWithWorkspaceRoot(root, () => t.execute(args, o));

  console.log('\n— Mocked flow —');
  {
    const m = mockHorde({ checks: [{ done: false, is_possible: true, queue_position: 1, wait_time: 2 }, { done: true }] });
    const t = createGenerateImageTool({ fetch: m.f, chromePath: noChrome, pollMs: 5 }) as Exec;
    const r = await run(t, { prompt: 'a red bicycle', out: 'img/bike.png', quality: 'draft' });
    ok('writes the image as WebP when no Chrome can convert', typeof r === 'string' && fs.existsSync(path.join(root, 'img/bike.webp')) && /Note: no local Chrome/.test(r), JSON.stringify(r));
    ok('reports model, seed, seconds and the AI-image caveat', typeof r === 'string' && /model Deliberate, seed 42, \d+s on AI Horde/.test(r) && /AI-generated image/.test(r), String(r));
    const sub = m.calls[0];
    ok('anonymous key and Client-Agent sent', sub.headers.apikey === '0000000000' && /^TierMux:[^:]+:anonymous$/.test(sub.headers['Client-Agent']), JSON.stringify(sub.headers));
    ok('no cancel on success', !m.cancelled());

    const m1 = mockHorde({});
    const again = await run(createGenerateImageTool({ fetch: m1.f, chromePath: noChrome }) as Exec, { prompt: 'x', out: 'img/bike.webp' });
    ok('existing file → refused before any request', isErr(again) && /already exists/.test(again.error) && /overwrite: true/.test(again.error) && m1.calls.length === 0, JSON.stringify(again));
    const m2 = mockHorde({});
    const over = await run(createGenerateImageTool({ fetch: m2.f, chromePath: noChrome }) as Exec, { prompt: 'x', out: 'img/bike.webp', overwrite: true });
    ok('overwrite: true replaces it', typeof over === 'string' && m2.calls.length > 0, JSON.stringify(over));
  }

  console.log('\n— Honest failures —');
  {
    const ref = mockHorde({ submit: { status: 403, json: { message: 'requires 67.7 kudos', rc: 'KudosUpfront' } } });
    const r1 = await run(createGenerateImageTool({ fetch: ref.f, chromePath: noChrome }) as Exec, { prompt: 'x', out: 'f1.webp' });
    ok('a refused submit names the reason', isErr(r1) && /403 KudosUpfront/.test(r1.error) && /67\.7 kudos/.test(r1.error), JSON.stringify(r1));

    const cen = mockHorde({ status: { done: true, generations: [{ img: WEBP_1PX, censored: true }] } });
    const r2 = await run(createGenerateImageTool({ fetch: cen.f, chromePath: noChrome }) as Exec, { prompt: 'x', out: 'f2.webp' });
    ok('censored → error, nothing written', isErr(r2) && /censored/.test(r2.error) && !fs.existsSync(path.join(root, 'f2.webp')), JSON.stringify(r2));

    for (const img of ['http://127.0.0.1:9/x.webp', 'https://localhost/x.webp', 'http://r2.example.com/x.webp']) {
      const loc = mockHorde({ status: { done: true, generations: [{ img, censored: false }] } });
      const r = await run(createGenerateImageTool({ fetch: loc.f, chromePath: noChrome }) as Exec, { prompt: 'x', out: 'f-loc.webp' });
      ok(`a download URL of ${img} is refused (https + public only)`, isErr(r) && /non-public address/.test(r.error) && !fs.existsSync(path.join(root, 'f-loc.webp')), JSON.stringify(r));
    }

    const flt = mockHorde({ checks: [{ done: false, faulted: true }] });
    const r3 = await run(createGenerateImageTool({ fetch: flt.f, chromePath: noChrome }) as Exec, { prompt: 'x', out: 'f3.webp' });
    ok('faulted → error and the job is cancelled', isErr(r3) && /faulted/.test(r3.error) && flt.cancelled(), JSON.stringify(r3));

    const imp = mockHorde({ checks: [{ done: false, is_possible: false }] });
    const r4 = await run(createGenerateImageTool({ fetch: imp.f, chromePath: noChrome }) as Exec, { prompt: 'x', out: 'f4.webp' });
    ok('no worker → error and cancel', isErr(r4) && /no AI Horde worker/.test(r4.error) && imp.cancelled(), JSON.stringify(r4));

    const slow = mockHorde({ checks: [{ done: false, is_possible: true, queue_position: 2, wait_time: 0 }] });
    const r5 = await run(createGenerateImageTool({ fetch: slow.f, chromePath: noChrome, deadlineMs: 60, pollMs: 10 }) as Exec, { prompt: 'x', out: 'f5.webp' });
    ok('deadline → error and cancel', isErr(r5) && /no result within/.test(r5.error) && slow.cancelled(), JSON.stringify(r5));

    const ab = mockHorde({ checks: [{ done: false, is_possible: true, queue_position: 1, wait_time: 1 }] });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const t0 = Date.now();
    const r7 = await run(createGenerateImageTool({ fetch: ab.f, chromePath: noChrome, pollMs: 5_000 }) as Exec, { prompt: 'x', out: 'f7.webp' }, { abortSignal: ctl.signal });
    ok('abort → cancelled promptly and the job withdrawn', isErr(r7) && /cancelled/.test(r7.error) && ab.cancelled() && Date.now() - t0 < 2_000, JSON.stringify(r7));
  }

  const chrome = findChromePath();
  if (!chrome) {
    console.log('\nSKIP  conversion + preview (no local Chrome/Edge/Chromium)');
  } else {
    console.log('\n— Conversion and preview through the local Chrome —');
    const m = mockHorde({});
    const t = createGenerateImageTool({ fetch: m.f }) as WithOutput;
    const r = await run(t, { prompt: 'x', out: 'conv/a.png' }, { toolCallId: 'gen-1' });
    const file = path.join(root, 'conv/a.png');
    ok('WebP converted to a real PNG at the named path', typeof r === 'string' && fs.existsSync(file) && sniffImage(fs.readFileSync(file)) === 'png', JSON.stringify(r));
    ok('reports the natural size', typeof r === 'string' && /1×1 PNG/.test(r), String(r));
    const mo = t.toModelOutput({ toolCallId: 'gen-1', output: r }) as { type: string; value: Array<{ type: string; mediaType?: string }> };
    ok('the model gets text + a JPEG preview', mo.type === 'content' && mo.value.some((p) => p.type === 'file' && p.mediaType === 'image/jpeg'));
    const j = await run(createGenerateImageTool({ fetch: mockHorde({}).f }) as Exec, { prompt: 'x', out: 'conv/b.jpg' });
    ok('WebP converted to JPEG for a .jpg out', typeof j === 'string' && sniffImage(fs.readFileSync(path.join(root, 'conv/b.jpg'))) === 'jpeg', JSON.stringify(j));
  }

  if (process.env.LIVE === '1') {
    console.log('\n— LIVE: one draft generation on AI Horde —');
    const t = createGenerateImageTool() as Exec;
    const r = await run(t, { prompt: 'a red bicycle leaning on a brick wall, photo', out: 'live/bike.png', quality: 'draft', aspect: 'square' });
    console.log(typeof r === 'string' ? r : r.error);
    ok('live generation wrote a file', typeof r === 'string' && /Generated .*live\/bike\.(png|webp) — 512×512/.test(r), JSON.stringify(r));
  } else {
    console.log('\nSKIP  live generation (set LIVE=1)');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad ? `\n${bad} FAILED` : '\nall passed');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

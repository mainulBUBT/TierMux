// generateImage — photos and illustrations from a real image model: AI Horde's anonymous queue
// (volunteer GPUs, keyless — apikey 0000000000 plus an honest Client-Agent). renderImage stays the
// tool for text + layout graphics; this one is for pixels no markup can draw. Horde returns WebP;
// a .png/.jpg `out` is converted through the local Chrome (cdp.ts), which also produces the JPEG
// preview a vision model gets (toolImages). Anonymous limits (probed 2026-11-12): ≤ 1024×1024
// pixels and ≤ ~30 SDXL steps, else the request is refused as "KudosUpfront".

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { CdpPipeClient, findChromePath } from './cdp';
import { withDeadline } from './browserVerify';
import { keepToolImage, toolImageOutput } from './toolImages';
import { isHostResolvingToPrivate } from './tiermuxWeb/fetcher/safe-fetch';

const HORDE = 'https://aihorde.net/api/v2';
const HARD_DEADLINE_MS = 6 * 60_000;
const POLL_MS = 5_000;
const PREVIEW_MAX_SIDE = 1024;
const DEFAULT_NEGATIVE = 'watermark, signature, text, blurry, lowres, jpeg artifacts, deformed';

export type Aspect = 'landscape' | 'square' | 'portrait';
export type Quality = 'draft' | 'standard';
export type ImageFormat = 'webp' | 'png' | 'jpeg';

const PRESETS: Record<Quality, { models: string[]; steps: number; sampler: string; cfg: number; karras: boolean; sizes: Record<Aspect, [number, number]> }> = {
  draft: {
    models: ['Deliberate'], steps: 20, sampler: 'k_euler_a', cfg: 7, karras: false,
    sizes: { landscape: [768, 448], square: [512, 512], portrait: [448, 768] },
  },
  standard: {
    models: ['AlbedoBase XL (SDXL)'], steps: 30, sampler: 'k_dpmpp_2m', cfg: 6, karras: true,
    sizes: { landscape: [1024, 576], square: [1024, 1024], portrait: [576, 1024] },
  },
};

export function sizeFor(aspect: Aspect = 'landscape', quality: Quality = 'standard'): [number, number] {
  return PRESETS[quality].sizes[aspect];
}

export function buildHordeRequest(input: { prompt: string; negativePrompt?: string; aspect?: Aspect; quality?: Quality }): Record<string, unknown> {
  const p = PRESETS[input.quality ?? 'standard'];
  const [width, height] = sizeFor(input.aspect, input.quality);
  const negative = [input.negativePrompt?.trim(), DEFAULT_NEGATIVE].filter(Boolean).join(', ');
  return {
    prompt: `${input.prompt.replace(/###/g, '').trim()} ### ${negative}`,
    params: { width, height, steps: p.steps, sampler_name: p.sampler, cfg_scale: p.cfg, karras: p.karras, n: 1 },
    models: p.models,
    nsfw: false,
    censor_nsfw: true,
    r2: true,
  };
}

export type CheckState =
  | { kind: 'done' }
  | { kind: 'waiting'; queuePosition: number; waitSeconds: number }
  | { kind: 'failed'; reason: string };

export function parseCheck(j: { done?: boolean; faulted?: boolean; is_possible?: boolean; queue_position?: number; wait_time?: number }): CheckState {
  if (j.faulted) return { kind: 'failed', reason: 'the Horde worker faulted while generating' };
  if (j.done) return { kind: 'done' };
  if (j.is_possible === false) return { kind: 'failed', reason: 'no AI Horde worker can serve this model and size right now' };
  return { kind: 'waiting', queuePosition: j.queue_position ?? 0, waitSeconds: j.wait_time ?? 0 };
}

export function pickGeneration(j: { generations?: Array<{ img?: string; censored?: boolean; model?: string; seed?: string }>; faulted?: boolean }):
  { img: string; model: string; seed?: string } | { error: string } {
  if (j.faulted) return { error: 'the Horde worker faulted while generating' };
  const g = j.generations?.[0];
  if (!g?.img) return { error: 'the Horde returned no image' };
  if (g.censored) return { error: 'the Horde safety filter censored the result (it judged it NSFW) — nothing was written; rephrase the prompt' };
  return { img: g.img, model: g.model ?? 'unknown model', seed: g.seed };
}

export function sniffImage(b: Uint8Array): ImageFormat | undefined {
  const s = (a: number, z: number) => Buffer.from(b.subarray(a, z)).toString('latin1');
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (s(1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  return undefined;
}

const EXT: Record<ImageFormat, string> = { webp: '.webp', png: '.png', jpeg: '.jpg' };

/** Where the image goes and in which format: the extension `out` names, when it is one we can
 *  produce (png/jpg need Chrome to convert), else WebP — what the Horde sends. */
export function planOut(out: string, canConvert: boolean): { path: string; format: ImageFormat; note?: string } {
  const ext = path.extname(out).toLowerCase();
  const base = ext ? out.slice(0, -ext.length) : out;
  const asked: ImageFormat | undefined = ext === '.webp' ? 'webp' : ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : undefined;
  if (asked === 'webp' || (asked && canConvert)) return { path: out, format: asked };
  if (asked) return { path: base + '.webp', format: 'webp', note: `no local Chrome to convert to ${asked.toUpperCase()}, so it was saved as WebP` };
  return { path: base + '.webp', format: 'webp' };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

/** Shows the bytes in headless Chrome at natural size; returns them in `format` (when it differs
 *  from what they are) and a ≤ PREVIEW_MAX_SIDE JPEG for the model. */
async function rasterize(chrome: string, bytes: Buffer, mime: string, format: ImageFormat | undefined, deadlineAt: number):
  Promise<{ converted?: Buffer; preview?: string; width: number; height: number }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-genimg-'));
  const client = CdpPipeClient.launch(chrome);
  try {
    const doc = path.join(tmpDir, 'view.html');
    fs.writeFileSync(doc, `<!doctype html><html><body style="margin:0"><img id="i" style="display:block" src="data:${mime};base64,${bytes.toString('base64')}"></body></html>`);
    const { sessionId: sid } = await withDeadline(client.newPage(), deadlineAt, 'deadline hit while opening a page');
    let loaded = false;
    client.on('Page.loadEventFired', (_p, s) => { if (s === sid) loaded = true; });
    await withDeadline(client.send('Page.enable', undefined, sid), deadlineAt, 'deadline hit at Page.enable');
    await withDeadline(client.send('Page.navigate', { url: `file://${doc.startsWith('/') ? '' : '/'}${doc.split(path.sep).map(encodeURIComponent).join('/')}` }, sid), deadlineAt, 'deadline hit while loading');
    await withDeadline((async () => { while (!loaded) await new Promise((r) => setTimeout(r, 50)); })(), Math.min(deadlineAt, Date.now() + 15_000), 'the image did not load in Chrome');
    const dims = await client.send('Runtime.evaluate', { expression: '[document.getElementById("i").naturalWidth, document.getElementById("i").naturalHeight]', returnByValue: true }, sid) as { result?: { value?: [number, number] } };
    const [width, height] = dims.result?.value ?? [0, 0];
    if (!width || !height) throw new Error('Chrome could not decode the image');
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid);
    const clip = (scale: number) => ({ x: 0, y: 0, width, height, scale });
    let converted: Buffer | undefined;
    if (format && format !== 'webp') {
      const shot = await withDeadline(client.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 92 } : {}), clip: clip(1) }, sid), deadlineAt, 'deadline hit converting the image') as { data: string };
      converted = Buffer.from(shot.data, 'base64');
    }
    let preview: string | undefined;
    try {
      const shot = await withDeadline(client.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, clip: clip(Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height))) }, sid), deadlineAt, 'deadline hit at the preview') as { data: string };
      preview = shot.data;
    } catch { /* no preview — the text result still stands */ }
    return { converted, preview, width, height };
  } finally {
    client.dispose();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface GenerateImageBindings {
  fetch?: typeof fetch;
  chromePath?: string;
  deadlineMs?: number;
  pollMs?: number;
}

export function createGenerateImageTool(bindings: GenerateImageBindings = {}) {
  return tool({
    description:
      'Generate a photo or illustration with an image model (AI Horde, free volunteer GPUs) and save it '
      + 'in the workspace — hero photos, product-style shots, scenes, textures, illustrations. Takes '
      + '20 s (draft) to ~3 min (standard). Describe subject, setting, style, lighting and camera/medium '
      + 'concretely. Not for text, logos, UI or diagrams — the model garbles those; use renderImage.',
    inputExamples: [
      { input: { prompt: 'a ceramic coffee cup on a sunlit wooden table, shallow depth of field, warm morning light, product photo', out: 'public/images/hero.png' } },
      { input: { prompt: 'flat vector illustration of a mountain lake at sunrise, pastel palette', out: 'assets/illustration.webp', aspect: 'square', quality: 'draft' } },
    ],
    inputSchema: z.object({
      prompt: z.string().describe('What the image shows: subject, setting, style, lighting, medium.'),
      out: z.string().describe('Workspace-relative path to write (.png, .jpg or .webp; anything else becomes .webp).'),
      aspect: z.enum(['landscape', 'square', 'portrait']).optional().describe('landscape 1024×576 (default), square 1024×1024, portrait 576×1024; draft quality is about half that.'),
      negativePrompt: z.string().optional().describe('Things to keep out of the image.'),
      quality: z.enum(['draft', 'standard']).optional().describe('standard (default): SDXL, ~1–3 min. draft: SD 1.5 at ~512 px, ~20–40 s — for quick looks.'),
      overwrite: z.boolean().optional().describe('Replace an existing file at `out` — only when the user asked for that file to be replaced.'),
    }),
    toModelOutput: ({ toolCallId, output }) => toolImageOutput(toolCallId, output,
      'The generated image follows. Check it shows what was asked (subject, composition, no garbled text, extra limbs or artifacts) — generate again with a sharper prompt if not.'),
    execute: async ({ prompt, out, aspect, negativePrompt, quality, overwrite }, options?: { toolCallId?: string; abortSignal?: AbortSignal }): Promise<string | { error: string }> => {
      if (!prompt.trim()) return { error: 'Pass a non-empty "prompt".' };
      const doFetch = bindings.fetch ?? fetch;
      const signal = options?.abortSignal;
      const chrome = findChromePath(bindings.chromePath);
      const plan = planOut(out, !!chrome);
      let outUri = resolveWorkspacePath(plan.path);
      if (!overwrite && await exists(outUri)) {
        return { error: `${plan.path} already exists — pick a new filename, or pass overwrite: true only if the user asked to replace it.` };
      }

      const version = vscode.extensions?.getExtension('mainul-islam.tiermux')?.packageJSON?.version ?? '3';
      const headers = { apikey: '0000000000', 'Client-Agent': `TierMux:${version}:anonymous`, 'Content-Type': 'application/json' };
      const body = buildHordeRequest({ prompt, negativePrompt, aspect, quality });
      const started = Date.now();
      const deadlineAt = started + (bindings.deadlineMs ?? HARD_DEADLINE_MS);
      let id: string | undefined;
      const cancel = () => { if (id) void doFetch(`${HORDE}/generate/status/${id}`, { method: 'DELETE', headers }).catch(() => undefined); };
      const fail = (why: string) => { cancel(); return { error: `Image generation failed: ${why}. Nothing was written.` }; };

      try {
        const sub = await doFetch(`${HORDE}/generate/async`, { method: 'POST', headers, body: JSON.stringify(body), signal });
        const sj = await sub.json().catch(() => ({})) as { id?: string; message?: string; rc?: string };
        if (!sub.ok || !sj.id) return { error: `AI Horde refused the request (HTTP ${sub.status}${sj.rc ? ` ${sj.rc}` : ''}): ${sj.message ?? 'no message'}. Nothing was written.` };
        id = sj.id;

        for (;;) {
          if (signal?.aborted) return fail('cancelled');
          const cr = await doFetch(`${HORDE}/generate/check/${id}`, { headers, signal });
          const cj = await cr.json().catch(() => ({})) as Parameters<typeof parseCheck>[0] & { message?: string };
          if (!cr.ok && cr.status !== 429) return fail(`the Horde lost the job (HTTP ${cr.status}: ${cj.message ?? 'no message'})`);
          const st = parseCheck(cr.ok ? cj : {});
          if (st.kind === 'done') break;
          if (st.kind === 'failed') return fail(st.reason);
          const left = deadlineAt - Date.now();
          if (left <= 0) {
            return fail(`no result within ${Math.round((bindings.deadlineMs ?? HARD_DEADLINE_MS) / 1000)}s (queue position ${st.queuePosition}, Horde estimate ${st.waitSeconds}s more) — the volunteer queue is busy; ${quality === 'draft' ? 'try again later' : 'try quality "draft" or again later'}`);
          }
          await new Promise<void>((r) => {
            const t = setTimeout(r, Math.min(bindings.pollMs ?? POLL_MS, left));
            signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
          });
        }

        const gen = pickGeneration(await (await doFetch(`${HORDE}/generate/status/${id}`, { headers, signal })).json() as Parameters<typeof pickGeneration>[0]);
        if ('error' in gen) return fail(gen.error);
        id = undefined;
        // The download URL comes from a third party's response: https to a public host only.
        if (gen.img.startsWith('http') && (!gen.img.startsWith('https://') || await isHostResolvingToPrivate(new URL(gen.img).hostname))) {
          return { error: 'Image generation failed: the Horde pointed the download at a non-public address. Nothing was written.' };
        }
        const raw = gen.img.startsWith('http')
          ? Buffer.from(await (await doFetch(gen.img, { signal })).arrayBuffer())
          : Buffer.from(gen.img, 'base64');
        const got = sniffImage(raw);
        if (!got) return { error: 'Image generation failed: the Horde returned bytes that are not an image. Nothing was written.' };

        let format = plan.format;
        let notes = plan.note ? [plan.note] : [];
        if (got !== format && !chrome) {
          format = got;
          notes = [`saved as ${got.toUpperCase()} — that is what the Horde returned and there is no local Chrome to convert it`];
          outUri = resolveWorkspacePath(plan.path.replace(/\.[A-Za-z0-9]+$/, '') + EXT[got]);
          if (!overwrite && await exists(outUri)) return { error: `${vscode.workspace.asRelativePath(outUri, false)} already exists — pick a new filename. Nothing was written.` };
        }
        let bytes: Buffer = raw;
        let dims = sizeFor(aspect, quality).join('×');
        if (chrome) {
          try {
            const r = await rasterize(chrome, raw, `image/${got}`, format !== got ? format : undefined, deadlineAt);
            if (r.converted) bytes = r.converted;
            if (r.preview) keepToolImage(options?.toolCallId, r.preview);
            dims = `${r.width}×${r.height}`;
          } catch (e) {
            if (format !== got) return { error: `Converting the image to ${format.toUpperCase()} failed (${e instanceof Error ? e.message : String(e)}). Ask for a .webp out instead. Nothing was written.` };
          }
        }
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(outUri, '..'));
        await vscode.workspace.fs.writeFile(outUri, bytes);

        const rel = vscode.workspace.asRelativePath(outUri, false);
        const secs = Math.round((Date.now() - started) / 1000);
        return [
          `Generated ${rel} — ${dims} ${format.toUpperCase()} (${Math.max(1, Math.round(bytes.length / 1024))} KB), model ${gen.model}${gen.seed ? `, seed ${gen.seed}` : ''}, ${secs}s on AI Horde.`,
          ...notes.map((n) => `Note: ${n}.`),
          'This is an AI-generated image: text, logos, hands and exact likenesses are unreliable, and it is not a photo of anything real — say so to the user and do not present it as one.',
        ].join('\n');
      } catch (e) {
        if (signal?.aborted) return fail('cancelled');
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

// REAL-network probe: attach a generated red PNG to a pinned vision model on a real
// keyless provider (opencode) through the REAL Router + provider stack, and print the
// model's reply. If the model answers "red", image delivery is proven end-to-end.
import * as fs from 'fs';
import * as zlib from 'zlib';
import { Router } from '../src/router/router';
import type { SecretStore } from '../src/config/secrets';
import type { SettingsStore } from '../src/config/settingsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { UsageTracker } from '../src/config/usage';

// ── minimal PNG encoder: solid color RGB image ──
function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) { const p = off + 1 + x * 3; raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = solidPng(96, 96, [220, 30, 30]); // solid red
const IMG_URL = 'data:image/png;base64,' + png.toString('base64');
console.log('probe image: 96x96 solid RED png,', IMG_URL.length, 'data-URL chars');

// ── real catalog from the synced catalog.json ──
const catalogJson = JSON.parse(fs.readFileSync('/Applications/MAMP/htdocs/TierMux/media/catalog.json', 'utf8'));
const models: Array<{ platform: string; modelId: string; [k: string]: unknown }> = catalogJson.models || [];
const catalog = {
  find: (platform: string, modelId: string) => models.find((m) => m.platform === platform && m.modelId === modelId),
  all: () => models,
} as unknown as Catalog;

// ── secret/settings mocks (opencode is keyless; the probe key is ignored) ──
const secrets = {
  cooldownRemaining: () => 0, getModelKey: async () => undefined, resolveKey: async () => 'probe-key',
  isToolIncompatible: () => false, isDeprecated: () => false, setStatus: () => {},
  setCooldownForKey: async () => {}, setCooldown: () => {}, keyCooldownRemaining: () => 0,
  getKeys: async () => ['probe-key'], markToolIncompatible: () => {}, markDeprecated: () => {},
  noteToolSoftFailure: () => {},
} as unknown as SecretStore;
const settings = {
  enabledByPriority: () => [{ platform: 'opencode', modelId: 'hy3-free', enabled: true, priority: 0 }],
  getCustomEndpoints: () => [], getEndpoint: () => undefined,
} as unknown as SettingsStore;

const router = new Router(secrets, settings, catalog, { add: () => {} } as UsageTracker);

const CANDIDATES = [
  'opencode::hy3-free',
  'opencode::mimo-v2.5-free',
  'kilo::stepfun/step-3.7-flash:free',
  'kilo::kilo-auto/free',
  'opencode::nemotron-3.5-lightning-free',
];

async function main() {
  const messages = [{
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'Describe this image. What color fills the entire picture? Answer in one short sentence.' },
      { type: 'image_url' as const, image_url: { url: IMG_URL, mime: 'image/png', filename: 'probe.png' } },
    ],
  }];
  for (const model of CANDIDATES) {
    console.log(`\n=== probing ${model} ===`);
    try {
      const result = await router.route(messages as never, { model, taskKind: 'vision' } as never);
      const msg = (result.response as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message;
      const text = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content);
      console.log(`served by: ${result.platform}/${result.model}`);
      console.log(`reply: ${String(text).slice(0, 300)}`);
      if (String(text).toLowerCase().includes('red')) { console.log('\nIMAGE DELIVERY: PASS (model saw the red image)'); process.exit(0); }
      console.log('model replied but did not say red');
    } catch (e) {
      console.log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log('\nIMAGE DELIVERY: could not confirm on any candidate');
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });

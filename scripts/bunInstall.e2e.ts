/* The bun auto-installer behind the keyless OpenCode lane: the minimal zip reader (store +
 *  deflate, central-directory walk) against a hand-built archive, the binary picker that skips
 *  the ~500-byte launcher shim, the release-asset map, and — most of all — the lane's offer
 *  flow in bunTransport: a declining installer is asked once and never again this session, an
 *  accepting one (pointing at a real bun when this machine has one) puts the lane on the shim,
 *  and with no installer registered the lane stays direct. Everything runs offline.
 *  Run: npm run test:e2e:bun-install */

import { execFileSync } from 'child_process';
import { deflateRawSync } from 'zlib';

import { OpenAICompatProvider } from '../src/providers/openai-compat';
import { pickBunBinary, readZipEntries } from '../src/providers/bunInstaller';
import { bunShimCallCount, ensureBunForLane, isBunAvailable, setBunInstaller, setBunPathOverride, __resetBunOfferState, __resetBunShimCallCount } from '../src/providers/bunTransport';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : ` — ${d}`}`);
  if (!c) bad++;
};

/* ---- build a zip by hand: one deflated entry, one stored entry, one stored folder ---- */
function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const stored = e.data;
    const data = e.deflate ? deflateRawSync(stored) : stored;
    const crc = crc32(stored);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(stored.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(stored.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

let crcTable: number[] | undefined;
function crc32(buf: Buffer): number {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function main(): Promise<void> {
  /* ---- the zip reader ---- */
  const big = Buffer.alloc(2_500_000, 7);
  const zip = buildZip([
    { name: 'bun-1.2.3/', data: Buffer.alloc(0) },
    { name: 'bun-1.2.3/bun.exe', data: Buffer.alloc(480, 1) },          // the launcher shim
    { name: 'bun-1.2.3/bun', data: big, deflate: true },               // the real binary, deflated
    { name: 'bun-1.2.3/README.txt', data: Buffer.from('hello zip'), deflate: true },
  ]);
  const entries = readZipEntries(zip);
  ok('zip reader walks the central directory', entries.length === 3 && entries.every((e) => e.name !== 'bun-1.2.3/'), entries.map((e) => e.name).join(','));
  const readme = entries.find((e) => e.name.endsWith('README.txt'));
  ok('deflated entries inflate', readme?.data.toString() === 'hello zip', String(readme?.data));
  const storedZip = buildZip([{ name: 'x/bun', data: Buffer.from('stored-data') }]);
  ok('stored entries read verbatim', readZipEntries(storedZip)[0].data.toString() === 'stored-data');
  const picked = pickBunBinary(entries, 'darwin');
  ok('the picker takes the big binary, not the launcher shim', picked?.length === big.length, String(picked?.length));
  ok('…by the platform\'s binary name', pickBunBinary(entries, 'win32')?.length === 480, 'win32 should pick bun.exe (shim here — size check happens in installBun)');
  let threw = false;
  try { readZipEntries(Buffer.from('not a zip')); } catch { threw = true; }
  ok('a malformed archive throws, not silently empty', threw);

  /* ---- the lane's offer flow ---- */
  const calls: string[] = [];
  setBunInstaller(async () => { calls.push('offer'); return false; });
  setBunPathOverride(undefined);
  const first = await ensureBunForLane();
  const second = await ensureBunForLane();
  ok('a declining installer is asked', calls.length === 1, JSON.stringify(calls));
  ok('…and never again this session', !first && !second && calls.length === 1);

  // A fresh process state per scenario matters here; the e2e runs bundled, so re-require is
  // not available — instead the accepting-installer scenario runs against the real binary
  // only when this machine has one, otherwise it asserts the false path.
  const bunOnPath = (() => { try { execFileSync('bun', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (bunOnPath) {
    setBunPathOverride(undefined);
    __resetBunShimCallCount();
    __resetBunOfferState();
    setBunInstaller(async () => { setBunPathOverride('bun'); return true; });
    const got = await ensureBunForLane();
    ok('an accepting installer makes the lane shimmable', got && (await isBunAvailable()), String(got));
    setBunInstaller(undefined);
    setBunPathOverride(undefined);
  } else {
    console.log('SKIP  accepting-installer flow (no bun on this machine — covered where CI has bun)');
  }
  setBunInstaller(undefined);
  setBunPathOverride(undefined);
  ok('no installer registered ⇒ the offer resolves false', !(await ensureBunForLane()));

  console.log(bad === 0 ? '\nall bun-install checks passed' : `\n${bad} check(s) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();

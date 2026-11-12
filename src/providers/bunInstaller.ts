/* The consent-prompted bun installer behind the keyless OpenCode lane. Zen's anonymous gate
 *  admits only the official client's network family (bun/BoringSSL), so the lane runs its
 *  requests through a local bun (bunTransport.ts). This module supplies one when the machine
 *  has none: it asks once, downloads the official release zip from GitHub (~40 MB) into the
 *  extension's own global storage, checked against the release's SHA-256 (~90 MB on disk — nothing is installed system-wide, no PATH
 *  is touched, uninstalling the extension removes it), pulls the single bun binary out of the
 *  zip, verifies it answers `--version`, and hands its path to the transport. Declines are
 *  remembered (7 days for "Not now", permanently for "Never ask" or the setting, until the
 *  `tiermux.installBun` command is run explicitly).
 *
 *  The zip reader is deliberately minimal — central directory walk, store + deflate — because
 *  bundling a zip dependency for one stored binary is not worth it; bun's release zips carry
 *  exactly one file we want (bun / bun.exe) beside a launcher shim we skip by size. */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { inflateRawSync } from 'zlib';

import * as vscode from 'vscode';

import { setBunInstaller, setBunPathOverride } from './bunTransport';

const INSTALL_DIR = 'bun';
const DECLINE_KEY = 'tiermux.bunInstallDeclinedAt';
const NEVER = Number.MAX_SAFE_INTEGER;
const DECLINE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** GitHub release asset for this machine. Bun ships no native windows-arm64; the x64 build is
 *  the documented route there (runs under emulation), same as their installer does. */
function releaseAsset(platform: NodeJS.Platform, arch: string): string | undefined {
  const p = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
  const a = arch === 'arm64' ? (platform === 'win32' ? 'x64' : 'aarch64') : arch === 'x64' ? 'x64' : undefined;
  return p && a ? `bun-${p}-${a}.zip` : undefined;
}

const RELEASES = 'https://github.com/oven-sh/bun/releases';
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** The latest release's tag, read from the redirect so the zip and its checksum come from the
 *  SAME release even if a new one ships mid-install. */
async function latestTag(): Promise<string> {
  const res = await fetch(`${RELEASES}/latest/download/SHASUMS256.txt`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const tag = /\/releases\/download\/([^/]+)\//.exec(res.headers.get('location') ?? '')?.[1];
  if (!tag) throw new Error(`could not resolve the latest bun release (HTTP ${res.status})`);
  return tag;
}

/** The asset's SHA-256 from the release's SHASUMS256.txt. Exported for e2e. */
export function shaFor(shasums: string, asset: string): string | undefined {
  for (const line of shasums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return undefined;
}

/** The binary's name inside the zip, and the stored copy's name. */
const bunName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'bun.exe' : 'bun');

/* ---------- minimal zip reader: central directory walk, store + deflate ---------- */

/** Every regular entry in the zip as {name, data}. Throws on a malformed archive. */
export function readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer }> {
  // Locate the end-of-central-directory record (scan back over a possible comment).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_536); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip has no end-of-central-directory record');
  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let c = 0; c < count; c++) {
    if (off + 46 > zip.length || zip.readUInt32LE(off) !== 0x02014b50) throw new Error('zip central directory is malformed');
    const method = zip.readUInt16LE(off + 10);
    const compSize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const name = zip.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const localOff = zip.readUInt32LE(off + 42);
    if (localOff + 30 <= zip.length && zip.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = zip.slice(dataStart, dataStart + compSize);
      if (!name.endsWith('/')) {
        if (method === 0) out.push({ name, data: Buffer.from(data) });
        else if (method === 8) out.push({ name, data: inflateRawSync(data) });
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The real bun binary from a release zip: the entry named bun[.exe] that is not the ~500-byte
 *  launcher shim some packages also carry. */
export function pickBunBinary(entries: Array<{ name: string; data: Buffer }>, platform: NodeJS.Platform): Buffer | undefined {
  const wanted = bunName(platform);
  const candidates = entries.filter((e) => e.name === wanted || e.name.endsWith('/' + wanted));
  return candidates.sort((a, b) => b.data.length - a.data.length)[0]?.data;
}

/* ---------- download + install ---------- */

async function download(url: string, report: (fraction: number) => void): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    got += chunk.length;
    if (total > 0) report(got / total);
  }
  if (total > 0 && got !== total) throw new Error(`download cut short (${got} of ${total} bytes)`);
  return Buffer.concat(chunks);
}

function runVersion(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 15_000);
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim() || '?' : null); });
  });
}

/** Runs the installer: download → extract → verify → hand the path to the transport. */
export async function installBun(context: vscode.ExtensionContext, report: (msg: string) => void): Promise<string> {
  const asset = releaseAsset(process.platform, process.arch);
  if (!asset) throw new Error(`no bun release for ${process.platform}/${process.arch}`);
  const dir = join(context.globalStorageUri.fsPath, INSTALL_DIR);
  const binPath = join(dir, bunName(process.platform));

  report('Finding the latest bun release');
  const tag = await latestTag();
  const sums = await fetch(`${RELEASES}/download/${tag}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
  const expected = sums.ok ? shaFor(await sums.text(), asset) : undefined;
  if (!expected) throw new Error(`no checksum for ${asset} in ${tag}`);
  report(`Downloading ${asset} (${tag})`);
  const zip = await download(`${RELEASES}/download/${tag}/${asset}`, (f) => report(`Downloading bun (${Math.round(f * 100)}%)`));
  if (createHash('sha256').update(zip).digest('hex') !== expected) throw new Error('the download does not match the release checksum');
  const binary = pickBunBinary(readZipEntries(zip), process.platform);
  if (!binary || binary.length < 1_000_000) throw new Error('the release zip carried no bun binary');
  await mkdir(dir, { recursive: true });
  // Written beside, verified, then renamed: a half-written file never sits at binPath, where
  // storedBunPath would take it for an install.
  const tmpPath = `${binPath}.download`;
  await rm(tmpPath, { force: true });
  await writeFile(tmpPath, binary);
  if (process.platform !== 'win32') await chmod(tmpPath, 0o755);
  const version = await runVersion(tmpPath);
  if (!version) { await rm(tmpPath, { force: true }); throw new Error('the downloaded bun does not run on this machine'); }
  await rm(binPath, { force: true });
  await rename(tmpPath, binPath);
  report(`bun ${version} ready`);
  setBunPathOverride(binPath);
  await context.globalState.update(DECLINE_KEY, undefined);
  return binPath;
}

/* ---------- consent + wiring ---------- */

/** Already-installed copy from a previous session, probed cheaply at activation. */
async function storedBunPath(context: vscode.ExtensionContext): Promise<string | undefined> {
  const binPath = join(context.globalStorageUri.fsPath, INSTALL_DIR, bunName(process.platform));
  try {
    const s = await stat(binPath);
    if (s.isFile() && s.size > 1_000_000) return binPath;
  } catch { /* not there yet */ }
  return undefined;
}

/** Wires the installer into the transport: the consent prompt the lane triggers, plus a
 *  command for an explicit retry after a decline. `whenIdle` resolves once no agent run is live:
 *  the extension host restarts only then, so a running turn is never cut. */
export function registerBunInstaller(context: vscode.ExtensionContext, whenIdle: () => Promise<void> = async () => {}): void {
  void storedBunPath(context).then((p) => { if (p) setBunPathOverride(p); });

  /** Install, then reload TierMux so the lane starts clean (its in-memory "free usage limit"
   *  quarantine from the bun-less attempts dies with the old host). */
  const installAndReload = async (): Promise<boolean> => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TierMux: installing bun for the OpenCode free lane' },
        (progress) => installBun(context, (msg) => progress.report({ message: msg })),
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`Installing bun failed: ${(e as Error).message}. You can install it yourself from https://bun.sh and TierMux will find it on the PATH.`);
      return false;
    }
    void (async () => {
      await whenIdle();
      void vscode.window.showInformationMessage('bun installed — reloading TierMux so OpenCode Zen\'s free models are used.');
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    })();
    return true;
  };

  const offer = async (): Promise<boolean> => {
    const stored = await storedBunPath(context);
    if (stored) { setBunPathOverride(stored); return true; }

    const mode = vscode.workspace.getConfiguration('tiermux').get<string>('opencode.bunInstall', 'prompt');
    const declinedAt = context.globalState.get<number>(DECLINE_KEY);
    if (mode === 'never' || declinedAt === NEVER) return false;
    if (declinedAt !== undefined && Date.now() - declinedAt < DECLINE_RETRY_MS) return false;

    // Modal: a toast slides into the bell unseen, and the lane then stayed shut all session.
    const pick = await vscode.window.showInformationMessage(
      'Install bun so OpenCode Zen\'s free models work without a key?',
      { modal: true, detail: 'TierMux downloads the official bun release (~40 MB, checksum-verified) into its own extension storage — nothing system-wide — then reloads TierMux once no chat turn is running.' },
      'Install bun', 'Not now', 'Never ask',
    );
    if (pick !== 'Install bun') {
      await context.globalState.update(DECLINE_KEY, pick === 'Never ask' ? NEVER : Date.now());
      return false;
    }
    return installAndReload();
  };

  // The command bypasses the decline memory — an explicit click means "yes, now".
  context.subscriptions.push(vscode.commands.registerCommand('tiermux.installBun', async () => {
    const stored = await storedBunPath(context);
    if (stored) { setBunPathOverride(stored); void vscode.window.showInformationMessage('bun is already installed for TierMux.'); return; }
    await installAndReload();
  }));

  setBunInstaller(offer);
}

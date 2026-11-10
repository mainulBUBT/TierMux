/* The consent-prompted bun installer behind the keyless OpenCode lane. Zen's anonymous gate
 *  admits only the official client's network family (bun/BoringSSL), so the lane runs its
 *  requests through a local bun (bunTransport.ts). This module supplies one when the machine
 *  has none: it asks once, downloads the official release zip from GitHub (~40 MB) into the
 *  extension's own global storage (~90 MB on disk — nothing is installed system-wide, no PATH
 *  is touched, uninstalling the extension removes it), pulls the single bun binary out of the
 *  zip, verifies it answers `--version`, and hands its path to the transport. Declines are
 *  remembered (7 days for "Not now", permanently for "Never ask" or the setting, until the
 *  `tiermux.installBun` command is run explicitly).
 *
 *  The zip reader is deliberately minimal — central directory walk, store + deflate — because
 *  bundling a zip dependency for one stored binary is not worth it; bun's release zips carry
 *  exactly one file we want (bun / bun.exe) beside a launcher shim we skip by size. */
import { spawn } from 'child_process';
import { chmod, mkdir, rm, stat, writeFile } from 'fs/promises';
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

function downloadUrl(asset: string): string {
  return `https://github.com/oven-sh/bun/releases/latest/download/${asset}`;
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
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    got += chunk.length;
    if (total > 0) report(got / total);
  }
  return Buffer.concat(chunks);
}

/** Runs the installer: download → extract → verify → hand the path to the transport. */
export async function installBun(context: vscode.ExtensionContext, report: (msg: string) => void): Promise<string> {
  const asset = releaseAsset(process.platform, process.arch);
  if (!asset) throw new Error(`no bun release for ${process.platform}/${process.arch}`);
  const dir = join(context.globalStorageUri.fsPath, INSTALL_DIR);
  const binPath = join(dir, bunName(process.platform));

  report(`Downloading ${asset}`);
  const zip = await download(downloadUrl(asset), (f) => report(`Downloading bun (${Math.round(f * 100)}%)`));
  const binary = pickBunBinary(readZipEntries(zip), process.platform);
  if (!binary || binary.length < 1_000_000) throw new Error('the release zip carried no bun binary');
  await mkdir(dir, { recursive: true });
  await rm(binPath, { force: true });
  await writeFile(binPath, binary);
  if (process.platform !== 'win32') await chmod(binPath, 0o755);

  const version = await new Promise<string | null>((resolve) => {
    const child = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 ? out.trim() || '?' : null));
  });
  if (!version) throw new Error('the downloaded bun does not run on this machine');
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
 *  command for an explicit retry after a decline. */
export function registerBunInstaller(context: vscode.ExtensionContext): void {
  void storedBunPath(context).then((p) => { if (p) setBunPathOverride(p); });

  const offer = async (): Promise<boolean> => {
    const stored = await storedBunPath(context);
    if (stored) { setBunPathOverride(stored); return true; }

    const mode = vscode.workspace.getConfiguration('tiermux').get<string>('opencode.bunInstall', 'prompt');
    const declinedAt = context.globalState.get<number>(DECLINE_KEY);
    if (mode === 'never' || declinedAt === NEVER) return false;
    if (declinedAt !== undefined && Date.now() - declinedAt < DECLINE_RETRY_MS) return false;

    const pick = await vscode.window.showInformationMessage(
      'TierMux can download bun (~40 MB, ~90 MB on disk, kept in this extension\'s storage — nothing system-wide) so OpenCode Zen\'s free models work without a key. Install it?',
      'Install bun', 'Not now', 'Never ask',
    );
    if (pick !== 'Install bun') {
      await context.globalState.update(DECLINE_KEY, pick === 'Never ask' ? NEVER : Date.now());
      return false;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TierMux: installing bun for the OpenCode free lane' },
        (progress) => installBun(context, (msg) => progress.report({ message: msg })),
      );
      void vscode.window.showInformationMessage('bun installed — OpenCode Zen\'s free models are now reachable from TierMux.');
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`Installing bun failed: ${(e as Error).message}. You can install it yourself from https://bun.sh and TierMux will find it on the PATH.`);
      return false;
    }
  };

  // The command bypasses the decline memory — an explicit click means "yes, now".
  context.subscriptions.push(vscode.commands.registerCommand('tiermux.installBun', async () => {
    const stored = await storedBunPath(context);
    if (stored) { setBunPathOverride(stored); void vscode.window.showInformationMessage('bun is already installed for TierMux.'); return; }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TierMux: installing bun for the OpenCode free lane' },
        (progress) => installBun(context, (msg) => progress.report({ message: msg })),
      );
      void vscode.window.showInformationMessage('bun installed — OpenCode Zen\'s free models are now reachable from TierMux.');
    } catch (e) {
      void vscode.window.showErrorMessage(`Installing bun failed: ${(e as Error).message}`);
    }
  }));

  setBunInstaller(offer);
}

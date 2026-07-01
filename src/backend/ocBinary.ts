// OpenCode binary resolver + downloader. Resolution order:
//
//   1. OPENCODE_BIN env override
//   2. bundled per-platform binary: resources/bin/{os}/{arch}/opencode[.exe]
//   3. cached download in globalStorage/bin (from a prior first-run fetch)
//   4. download the platform binary on first run (Option 1 distribution)
//   5. system `opencode` on PATH
//
// The first-run download (step 4) is what makes the marketplace vsix work for end
// users without a bundled binary: one small vsix, auto-fetches the right OpenCode
// build per platform on first activation, caches it forever after.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';

const STABLE_DIR = 'tiermux-opencode-bin';
const RELEASE_BASE = 'https://github.com/anomalyco/opencode/releases';

function detectOS(): 'windows' | 'macos' | 'linux' {
  switch (os.platform()) {
    case 'win32': return 'windows';
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    default: throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

function detectArch(): 'amd64' | 'arm64' {
  switch (os.arch()) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    default: throw new Error(`Unsupported architecture: ${os.arch()}`);
  }
}

/** Map this machine to an OpenCode release asset target, or undefined if none ships. */
function releaseTarget(osType: string, arch: string): string | undefined {
  // OpenCode publishes: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64.
  if (osType === 'macos') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (osType === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (osType === 'windows') return arch === 'amd64' ? 'windows-x64' : undefined; // no win-arm64 build
  return undefined;
}

interface ResolveOptions {
  /** Writable cache dir (VS Code globalStoragePath) for the downloaded binary. */
  cacheDir?: string;
  /** Progress callback for the first-run download (surfaced in a withProgress notification). */
  onProgress?: (message: string) => void;
  /** Optional logger that mirrors resolution + download diagnostics into the
   *  "TierMux Engine" Output channel. */
  log?: (message: string) => void;
}

/**
 * Resolve the OpenCode binary path. Steps 1–3 are instant; step 4 (first-run download)
 * only runs once and is then cached. Never throws — returns undefined only when no
 * release exists for this platform.
 */
export async function resolveOcBinary(extensionPath: string, opts: ResolveOptions = {}): Promise<string | undefined> {
  const log = opts.log ?? (() => undefined);
  const osType = detectOS();
  const arch = detectArch();
  const binaryName = osType === 'windows' ? 'opencode.exe' : 'opencode';
  log(`detected platform: ${osType}/${arch}`);

  // 1. Explicit override (dev / power users pointing at a custom build).
  const override = process.env.OPENCODE_BIN?.trim();
  if (override && fs.existsSync(override)) { log(`using OPENCODE_BIN override: ${override}`); return override; }
  if (override) log(`OPENCODE_BIN set but missing on disk: ${override}`);

  // 2. Bundled binary for this platform (the Option 2 packaging path).
  const bundled = path.join(extensionPath, 'resources', 'bin', osType, arch, binaryName);
  if (fs.existsSync(bundled)) {
    log(`found bundled binary: ${bundled}`);
    try {
      return await extractToStable(bundled, binaryName, osType);
    } catch (err) {
      log(`bundled extraction failed: ${err instanceof Error ? err.message : err}`);
      console.warn('[tiermux] OC bundled binary extraction failed:', err);
    }
  } else {
    log(`no bundled binary at ${bundled} — will try cache or download`);
  }

  // 3 + 4. Cached download, or fetch on first run.
  if (opts.cacheDir) {
    const cached = path.join(opts.cacheDir, 'bin', binaryName);
    if (fs.existsSync(cached)) { log(`using cached binary: ${cached}`); return cached; }
    try {
      const downloaded = await downloadBinary(opts.cacheDir, osType, arch, binaryName, opts.onProgress, log);
      if (downloaded) return downloaded;
    } catch (err) {
      log(`download failed: ${err instanceof Error ? err.message : err}`);
      console.warn('[tiermux] OC binary download failed, falling back to PATH:', err);
      opts.onProgress?.(`TierMux engine download failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    log(`no cacheDir provided — skipping download`);
  }

  // 5. System opencode on PATH. (Verified lazily by the launcher's spawn.)
  log(`falling back to 'opencode' on PATH (may not exist)`);
  return 'opencode';
}

/** Copy the bundled binary to a stable temp dir + chmod, so re-extraction is idempotent. */
async function extractToStable(src: string, binaryName: string, osType: string): Promise<string> {
  const stableDir = path.join(os.tmpdir(), STABLE_DIR);
  await fs.promises.rm(stableDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.mkdir(stableDir, { recursive: true });
  const dest = path.join(stableDir, binaryName);
  await fs.promises.copyFile(src, dest);
  if (osType !== 'windows') await fs.promises.chmod(dest, 0o755).catch(() => undefined);
  return dest;
}

/**
 * Download the platform's OpenCode binary into cacheDir/bin. Returns the binary path,
 * or undefined if no release ships for this platform (e.g. windows-arm64).
 */
async function downloadBinary(
  cacheDir: string,
  osType: string,
  arch: string,
  binaryName: string,
  onProgress?: (m: string) => void,
  log?: (m: string) => void,
): Promise<string | undefined> {
  const target = releaseTarget(osType, arch);
  if (!target) {
    onProgress?.(`No OpenCode release for ${osType}/${arch}; set OPENCODE_BIN or install opencode on PATH.`);
    log?.(`no release target for ${osType}/${arch}`);
    return undefined;
  }
  // macOS + Windows ship as .zip; Linux as .tar.gz (verified against the release assets).
  const ext = osType === 'linux' ? 'tar.gz' : 'zip';
  const url = `${RELEASE_BASE}/latest/download/opencode-${target}.${ext}`;
  const archive = path.join(cacheDir, `opencode-${target}.${ext}`);
  const extractDir = path.join(cacheDir, `_extract-${target}`);
  const binDir = path.join(cacheDir, 'bin');
  await fs.promises.mkdir(cacheDir, { recursive: true });

  onProgress?.(`Downloading TierMux engine (${target})…`);
  log?.(`GET ${url} → ${archive}`);
  await download(url, archive, (mb) => onProgress?.(`Downloading TierMux engine (${target})… ${mb} MB`));
  log?.(`download complete: ${archive}`);

  // `tar -xf` extracts both .zip and .tar.gz on macOS/Linux/Win10+.
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.mkdir(extractDir, { recursive: true });
  await run('tar', ['-xf', archive, '-C', extractDir]);

  const found = findFile(extractDir, binaryName);
  if (!found) throw new Error(`"${binaryName}" not found in the downloaded archive`);
  await fs.promises.mkdir(binDir, { recursive: true });
  const dest = path.join(binDir, binaryName);
  await fs.promises.copyFile(found, dest);
  if (osType !== 'windows') await fs.promises.chmod(dest, 0o755).catch(() => undefined);
  log?.(`extracted → ${dest}`);

  // Clean up the archive + extraction scratch.
  await fs.promises.rm(archive, { force: true }).catch(() => undefined);
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  return dest;
}

/** Max time (ms) the first-run OC binary download is allowed to take before
 *  we abort with a clear error. 10 min is generous: real-world worst case on a
 *  very slow link for a 41 MB archive is ~15 min, but anything past 10 min
 *  almost certainly means the network is dead and the user should know. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Stream a URL to disk, reporting downloaded MB via onProgress. Aborts after
 *  DOWNLOAD_TIMEOUT_MS so a hung network doesn't sit forever. */
async function download(url: string, dest: string, onProgress?: (mb: number) => void): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  let received = 0;
  let lastReport = 0;
  const onChunk = (chunk: Uint8Array) => {
    received += chunk.length;
    const mb = Math.floor(received / 1_000_000);
    if (onProgress && mb >= lastReport + 1) { lastReport = mb; onProgress(mb); }
  };
  // Tee the stream so we can report progress without buffering the whole body.
  const reportStream = new TransformStream({
    transform: (chunk, controller) => { onChunk(chunk as Uint8Array); controller.enqueue(chunk); },
  });
  try {
    await pipeline(res.body.pipeThrough(reportStream), fs.createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/** Find `name` anywhere under `root` (release archives nest it under bin/). */
function findFile(root: string, name: string): string | undefined {
  const direct = path.join(root, 'bin', name);
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(path.join(root, name))) return path.join(root, name);
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === name) return full;
    }
  }
  return undefined;
}

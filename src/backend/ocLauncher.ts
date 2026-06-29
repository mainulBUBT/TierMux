// OpenCode backend launcher. Spawns `opencode serve` headless, pointing it at the
// TierMux router proxy via OPENCODE_CONFIG_CONTENT, and discovers its URL from
// stdout. Ports paviko/opencode-ide-plugin's BackendLauncher, adapted to inject
// our routing config and to fail soft (a missing/broken OC binary just leaves the
// integration off — the built-in agent keeps working).
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import { resolveOcBinary } from './ocBinary';
import { buildOcConfig } from './ocConfig';

export interface OcConnection {
  port: number;
  /** OC's HTTP API base, e.g. http://127.0.0.1:4099 */
  baseURL: string;
  /** Password OC requires (Basic auth) — the webview SDK must send it. */
  password: string;
  process: ChildProcess;
}

/** Total time we wait for the OC server to print its listening URL.
 *  Generous because first-run binary download is gated by user network speed
 *  (the 41 MB darwin-arm64 archive has been seen to take ~15 min on slow links). */
const LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

export interface OcLaunchOptions {
  extensionPath: string;
  routerProxyBaseURL: string;
  workspaceRoot?: string;
  /** Writable cache dir (VS Code globalStoragePath) for the first-run binary download. */
  cacheDir?: string;
  /** Progress callback for the first-run download. */
  onProgress?: (message: string) => void;
  /** Optional logger that mirrors progress + diagnostics into the "TierMux Engine"
   *  Output channel. Kept separate from `onProgress` so progress can keep flowing
   *  into the withProgress notification while logs land in the channel. */
  log?: (message: string) => void;
}

/** Random per-session password so the loopback OC server isn't fully open. */
function newPassword(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Spawn `opencode serve` and resolve once it prints its listening URL.
 * Rejects if no binary is available or the server fails to come up — the caller
 * is expected to catch and continue without the OC engine.
 */
export async function launchOpenCode(opts: OcLaunchOptions): Promise<OcConnection> {
  const log = opts.log ?? (() => undefined);
  log(`resolving OpenCode binary…`);
  const binary = await resolveOcBinary(opts.extensionPath, {
    cacheDir: opts.cacheDir,
    onProgress: opts.onProgress,
    log,
  });
  if (!binary) {
    throw new Error('OpenCode binary not found (set OPENCODE_BIN, install opencode, or bundle it).');
  }
  log(`binary resolved: ${binary}`);

  const password = newPassword();
  const configContent = buildOcConfig({ routerProxyBaseURL: opts.routerProxyBaseURL, apiKey: 'local' });
  const cwd = opts.workspaceRoot ?? process.cwd();

  // `--port 0` lets the OS pick an ephemeral port; we read the real one from stdout.
  const args = [binary, 'serve', '--port', '0', '--hostname', '127.0.0.1'];
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);

  log(`spawning: ${args.join(' ')} (cwd=${cwd})`);
  const child = spawn(args[0], args.slice(1), {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: configContent,
      OPENCODE_SERVER_PASSWORD: password,
    },
    shell,
    windowsHide: true,
  });

  return new Promise<OcConnection>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`FAIL: ${msg}`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`${msg}${stderr ? `\nOC stderr:\n${stderr.slice(-2000)}` : ''}`));
    };

    const timer = setTimeout(
      () => fail(`Timed out after ${LAUNCH_TIMEOUT_MS / 1000}s waiting for OpenCode server to start. (First-run binary download can take several minutes on slow networks — see the TierMux Engine output channel.)`),
      LAUNCH_TIMEOUT_MS,
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      log(`[oc stdout] ${text.trimEnd()}`);
      // OC logs: `opencode server listening on http://127.0.0.1:4099`
      const match = stdout.match(/opencode server listening on (https?:\/\/\S+)/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        try {
          const url = new URL(match[1]);
          const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
          log(`OC ready at ${url.protocol}//${url.hostname}:${port}`);
          resolve({ port, baseURL: `${url.protocol}//${url.hostname}:${port}`, password, process: child });
        } catch (err) {
          fail(`Failed to parse OpenCode URL "${match[1]}": ${err}`);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      log(`[oc stderr] ${text.trimEnd()}`);
    });
    child.on('error', (err) => fail(`OpenCode process error: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (!settled) fail(`OpenCode exited early (code ${code}, signal ${signal}).`);
    });
  });
}

/** Graceful shutdown: SIGTERM, then SIGKILL after a grace window. */
export function stopOpenCode(conn: OcConnection | undefined): void {
  if (!conn) return;
  const proc = conn.process;
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* ignore */ }
  }, 5_000);
}

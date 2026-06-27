import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import * as https from 'https';

const existsAsync = promisify(fs.exists);
const mkdirAsync = promisify(fs.mkdir);

export interface OpenCodeInstance {
  port: number;
  password: string;
  baseUrl: string;
  process: ChildProcess;
}

export class OpenCodeManager {
  private instance: OpenCodeInstance | null = null;
  private startupPromise: Promise<OpenCodeInstance> | null = null;

  private extraEnv: Record<string, string> = {};

  constructor(
    private context: vscode.ExtensionContext,
    extraEnv?: Record<string, string>,
  ) {
    if (extraEnv) this.extraEnv = extraEnv;
  }

  /** Update or set extra environment variables for the spawned server process.
   *  Only takes effect before `getServer()` starts the process. */
  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = { ...this.extraEnv, ...env };
  }

  async getServer(): Promise<OpenCodeInstance> {
    if (this.instance) return this.instance;
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.startServer();
    try {
      this.instance = await this.startupPromise;
      return this.instance;
    } finally {
      this.startupPromise = null;
    }
  }

  /** Check if the binary needs downloading (no bundled, no cached, no system install). */
  async needsDownload(): Promise<boolean> {
    try {
      const cacheDir = path.join(this.context.globalStoragePath, 'opencode-bin');
      const platform = process.platform;
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const binName = platform === 'win32' ? 'opencode.exe' : 'opencode';
      const bundled = path.join(this.context.extensionPath, 'bin', platform, arch, binName);
      if (await existsAsync(bundled)) return false;
      const cached = path.join(cacheDir, binName);
      if (await existsAsync(cached)) return false;
      const hasPath = await this.findOnPath('opencode');
      return !hasPath;
    } catch { return true; }
  }

  private async startServer(): Promise<OpenCodeInstance> {
    const password = randomBytes(16).toString('hex');
    const cliPath = await this.resolveBinary();

    return new Promise((resolve, reject) => {
      const serverProcess = spawn(cliPath, ['serve', '--port', '0', '--print-logs'], {
        env: {
          ...process.env,
          ...this.extraEnv,
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          serverProcess.kill();
          reject(new Error('OpenCode server did not start within 15s'));
        }
      }, 15000);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const port = parseInt(match[1], 10);
          resolve({
            port,
            password,
            baseUrl: `http://127.0.0.1:${port}`,
            process: serverProcess,
          });
        }
      };

      serverProcess.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        onData(chunk);
        // After server resolves, capture output unconditionally
        if (this.instance) process.stdout.write(`[TierMux OC stdout] ${text}`);
      });
      serverProcess.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        onData(chunk);
        // Always log stderr — this is where errors appear
        process.stderr.write(`[TierMux OC stderr] ${text}`);
      });

      serverProcess.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      serverProcess.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`OpenCode server exited with code ${code}`));
        }
        if (this.instance?.process === serverProcess) {
          this.instance = null;
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.instance) {
      this.instance.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.instance) {
          this.instance.process.kill('SIGKILL');
          this.instance = null;
        }
      }, 5000);
    }
  }

  private async resolveBinary(): Promise<string> {
    const binDir = path.join(this.context.extensionPath, 'bin');
    const platform = process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

    // Check bundled binary
    const bundledPath = path.join(binDir, platform, arch, platform === 'win32' ? 'opencode.exe' : 'opencode');
    if (await existsAsync(bundledPath)) {
      fs.chmodSync(bundledPath, 0o755);
      return bundledPath;
    }

    // Check system PATH
    const which = await this.findOnPath('opencode');
    if (which) return which;

    // Check temp/cache directory
    const cacheDir = path.join(this.context.globalStoragePath, 'opencode-bin');
    const cachePath = path.join(cacheDir, platform === 'win32' ? 'opencode.exe' : 'opencode');
    if (await existsAsync(cachePath)) {
      fs.chmodSync(cachePath, 0o755);
        return cachePath;
    }

    // Auto-download to cache directory on first run
    await this.downloadBinary(cacheDir, platform, arch);
    if (await existsAsync(cachePath)) {
        fs.chmodSync(cachePath, 0o755);
        return cachePath;
    }

    throw new Error(
        'OpenCode binary not found. Install it via `npm i -g opencode-ai` or place it in `bin/` directory.',
    );
}

private async downloadBinary(cacheDir: string, platform: string, arch: string): Promise<void> {
    await mkdirAsync(cacheDir, { recursive: true });
    const assetName = this.platformAssetName(platform, arch);
    if (!assetName) throw new Error(`Unsupported platform: ${platform}/${arch}`);

    console.log(`[TierMux] Downloading OpenCode binary (${assetName})…`);
    const tag = await this.getLatestReleaseTag();
    if (!tag) throw new Error('Could not determine latest release');

    const tarUrl = `https://github.com/anomalyco/opencode/releases/download/${tag}/${assetName}`;
    const tarPath = path.join(cacheDir, assetName);
    await this.downloadFile(tarUrl, tarPath);
    await this.extractTarGz(tarPath, cacheDir);
    fs.unlinkSync(tarPath);
    const binPath = path.join(cacheDir, platform === 'win32' ? 'opencode.exe' : 'opencode');
    if (await existsAsync(binPath)) fs.chmodSync(binPath, 0o755);
    console.log(`[TierMux] OpenCode downloaded to ${binPath}`);
}

private platformAssetName(platform: string, arch: string): string | null {
    const map: Record<string, Record<string, string>> = {
        darwin: { arm64: 'opencode-macos-arm64.tar.gz', x64: 'opencode-macos-x64.tar.gz' },
        linux:  { arm64: 'opencode-linux-arm64.tar.gz',  x64: 'opencode-linux-x64.tar.gz' },
        win32:  { x64: 'opencode-windows-x64.tar.gz' },
    };
    return map[platform]?.[arch] ?? null;
}

private getLatestReleaseTag(): Promise<string | null> {
    return new Promise((resolve) => {
        https.get('https://api.github.com/repos/anomalyco/opencode/releases/latest', {
            headers: { 'User-Agent': 'TierMux/1.0', Accept: 'application/vnd.github.v3+json' },
        }, (res) => {
            let data = '';
            res.on('data', (c: Buffer) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data).tag_name ?? null); }
                catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, { headers: { 'User-Agent': 'TierMux/1.0' } }, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                file.close(); fs.unlinkSync(dest);
                void this.downloadFile(res.headers.location, dest).then(resolve, reject);
                return;
            }
            res.pipe(file);
            file.on('finish', resolve);
        }).on('error', (err) => {
            file.close(); try { fs.unlinkSync(dest); } catch {}
            reject(err);
        });
    });
}

private async extractTarGz(tarPath: string, dest: string): Promise<void> {
    const { execSync } = await import('child_process');
    execSync(`tar -xzf "${tarPath}" -C "${dest}"`, { stdio: 'pipe', timeout: 60000 });
}

private findOnPath(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const proc = spawn(cmd, [name]);
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('close', (code) => {
        resolve(code === 0 ? output.trim().split('\n')[0] : null);
      });
    });
  }

  isRunning(): boolean {
    return this.instance !== null;
  }

  get baseUrl(): string | null {
    return this.instance?.baseUrl ?? null;
  }

  get password(): string | null {
    return this.instance?.password ?? null;
  }
}

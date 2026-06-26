import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';

const existsAsync = promisify(fs.exists);

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

    throw new Error(
      'OpenCode binary not found. Install it via `npm i -g opencode-ai` or place it in `bin/` directory.',
    );
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

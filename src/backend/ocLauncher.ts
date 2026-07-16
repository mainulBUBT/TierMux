

import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveOcBinary } from './ocBinary';
import { buildOcConfig } from './ocConfig';
import { loadUserMemory } from '../context/userMemory';
import { loadProjectRules } from '../context/projectRules';
import { skillIndexPrompt } from '../context/skills';
import type { McpServerConfig } from '../mcp/mcpClient';

/**
 * Load agent prompt files from `.tiermux/agent/` in the extension directory, plus the
 * workspace's project rule files (AGENTS.md, CLAUDE.md, .cursorrules, ... — see
 * projectRules.ts), `.tiermux/memory.md` (user style/standing instructions), and the
 * installed-skills index, if present. Files are sorted alphabetically and concatenated
 * so the order is predictable (identity.md → behavior.md → ask-format.md → any future
 * additions), with rules/memory/skills appended last. Falls back to a minimal inline
 * string if the directory is missing or unreadable.
 */
export async function loadAgentInstructions(extensionPath: string, log: (m: string) => void, workspaceRoot?: string): Promise<{ agentPrompt: string; instructions: string }> {
  const agentDir = path.join(extensionPath, '.tiermux', 'agent');
  let base: string;
  try {
    const files = fs.readdirSync(agentDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    if (!files.length) throw new Error('no .md files found');
    base = files
      .map((f) => {
        try { return fs.readFileSync(path.join(agentDir, f), 'utf8').trim(); }
        catch { return ''; }
      })
      .filter(Boolean)
      .join('\n\n');
  } catch (err) {
    log(`[tiermux] could not load .tiermux/agent/ prompts: ${err instanceof Error ? err.message : err} — using fallback`);
    base = '# Identity\nYou are TierMux, an AI coding assistant. Never identify as "opencode".';
  }
  const memory = await loadUserMemory().catch(() => '');
  const rules = await loadProjectRules().catch(() => '');
  const skills = skillIndexPrompt(extensionPath, workspaceRoot);
  // `base` (the .tiermux/agent scaffolding) becomes the agents' `prompt` so it LEADS the
  // system prompt and replaces OC's "You are opencode…" preamble. Dynamic per-workspace
  // context (project rules, user memory, skills index) stays in the appended instructions
  // file. Splitting the two avoids double-injecting `base` and keeps the prompt compact.
  return {
    agentPrompt: base,
    instructions: [rules, memory, skills].filter(Boolean).join('\n\n'),
  };
}

/** Write the dynamic instructions (rules/memory/skills) to a temp file so OC can load them
 *  via the `instructions` config. Returns the file path plus the core agent scaffolding to
 *  set as the agents' `prompt`. */
async function writeInstructionsFile(extensionPath: string, cacheDir: string | undefined, workspaceRoot: string | undefined, log: (m: string) => void): Promise<{ file?: string; agentPrompt?: string }> {
  try {
    const { agentPrompt, instructions } = await loadAgentInstructions(extensionPath, log, workspaceRoot);
    let file: string | undefined;
    if (instructions.trim()) {
      const dir = cacheDir ?? os.tmpdir();
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'tiermux-instructions.md');
      fs.writeFileSync(file, instructions, 'utf8');
      log(`[tiermux] wrote dynamic instructions (${instructions.length} chars) → ${file}`);
    }
    log(`[tiermux] agent prompt scaffolding: ${agentPrompt.length} chars (set as build/plan prompt)`);
    return { file, agentPrompt };
  } catch (err) {
    log(`could not write instructions file: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

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
  /**
   * `tm_<base64url>` encoded IDs of all currently enabled catalog and custom-endpoint
   * models. Baked into the OC config's static `models` block so OC accepts them at
   * session creation. See buildOcConfig / ocConfig.ts.
   */
  enabledModelIds?: string[];
  /** `tiermux.mcpServers` setting — forwarded to buildOcConfig() so OC natively
   *  discovers and calls these servers' tools itself. */
  mcpServers?: Record<string, McpServerConfig>;
  /** `tiermux.engine.compaction` setting — forwarded to buildOcConfig() so OC
   *  auto-compacts long conversations server-side (Fix 1). */
  compaction?: { auto: boolean; tailTurns: number; preserveRecentTokens: number; reserved: number };
  /** Progress callback for the first-run download. */
  onProgress?: (message: string, percent?: number) => void;
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
  log(`binary resolved: ${binary}`);

  const password = newPassword();
  const { file: instructionsFile, agentPrompt } = await writeInstructionsFile(opts.extensionPath, opts.cacheDir, opts.workspaceRoot, log);
  const configContent = buildOcConfig({
    routerProxyBaseURL: opts.routerProxyBaseURL,
    apiKey: 'local',
    agentPrompt,
    instructionsPaths: instructionsFile ? [instructionsFile] : undefined,
    extraModelIds: opts.enabledModelIds,
    mcpServers: opts.mcpServers,
    compaction: opts.compaction,
  });
  const cwd = opts.workspaceRoot ?? process.cwd();

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
      () => fail(`Timed out after ${LAUNCH_TIMEOUT_MS / 1000}s waiting for the TierMux engine to start. (First-run binary download can take several minutes on slow networks — see the TierMux Engine output channel.)`),
      LAUNCH_TIMEOUT_MS,
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      log(`[oc stdout] ${text.trimEnd()}`);

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

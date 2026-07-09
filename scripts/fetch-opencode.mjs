#!/usr/bin/env node
// Downloads the OpenCode binary for every supported platform and places it in the
// layout ocBinary.ts expects: resources/bin/{macos,linux,windows}/{amd64,arm64}/opencode[.exe].
//
// Mirrors paviko/opencode-ide-plugin's resources/bin layout. Run before `vsce package`
// to bundle OC into the .vsix (the "full" variant). Skipped entirely for the
// "gui-only" variant, which relies on a system-installed opencode.
//
//   OC_VERSION=latest  node scripts/fetch-opencode.mjs   # default (uses the pinned version below)
//   OC_VERSION=1.0.180 node scripts/fetch-opencode.mjs   # override pin
//   OC_TARGETS=linux-x64,darwin-arm64 node scripts/fetch-opencode.mjs  # subset
//
// Release assets: https://github.com/anomalyco/opencode/releases
//   opencode-{linux,darwin,windows}-{x64,arm64}.{tar.gz|zip}
//
// ── Pinned version ────────────────────────────────────────────────────────
// Pinned to anomalyco/opencode v1.17.11 (verified end-to-end against the OC
// bridge in TierMux v0.1.0-beta.6: router proxy → OC engine → chat round-trip
// works with this exact build). Update the pin only after re-verifying the
// bridge: enable `tiermux.engine.traceOcEvents`, send a chat, confirm the
// engine log shows `OC session created` + `[oc-event] …` frames + token
// counters populate.
//
// MUST stay in sync with package.json's "@opencode-ai/sdk" dependency version —
// src/backend/ocClient.ts wraps that SDK, and its generated types/behavior are
// specific to this exact server version. `npm run check:oc-version` (also runs
// automatically before `npm run typecheck`) fails loudly if these drift apart.
// See scripts/check-oc-sdk-version.mjs for the full upgrade procedure.
const PINNED_OC_VERSION = '1.17.11';
import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(ROOT, 'resources', 'bin');
const VERSION = process.env.OC_VERSION || PINNED_OC_VERSION;

// release-asset target → local {osDir}/{archDir}. Note the asset uses `x64` but
// the on-disk layout uses `amd64` (and `darwin`→`macos`), matching ocBinary.ts.
const TARGETS = {
  'linux-x64': { osDir: 'linux', archDir: 'amd64' },
  'linux-arm64': { osDir: 'linux', archDir: 'arm64' },
  'darwin-x64': { osDir: 'macos', archDir: 'amd64' },
  'darwin-arm64': { osDir: 'macos', archDir: 'arm64' },
  'windows-x64': { osDir: 'windows', archDir: 'amd64' },
};

const log = (m) => console.log(`[fetch-opencode] ${m}`);
const run = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });

async function download(url, dest) {
  log(`GET ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function extract(archive, targetDir, isWindows) {
  mkdirSync(targetDir, { recursive: true });
  if (isWindows) {
    // .zip → use the system unzipper (unzip on unix, tar -xf on modern Windows/tar).
    if (os.platform() === 'win32') await run('tar', ['-xf', archive, '-C', targetDir]);
    else await run('unzip', ['-o', archive, '-d', targetDir]);
  } else {
    // .tar.gz
    await run('tar', ['-xzf', archive, '-C', targetDir]);
  }
}

async function fetchTarget(target, mapping) {
  // macOS + Windows ship as .zip; Linux as .tar.gz (matches the upstream release assets).
  const ext = target.startsWith('linux') ? 'tar.gz' : 'zip';
  const versionPath = VERSION === 'latest' ? 'latest/download' : `download/v${VERSION.replace(/^v/, '')}`;
  const url = `https://github.com/anomalyco/opencode/releases/${versionPath}/opencode-${target}.${ext}`;
  const archive = join(BIN_DIR, `opencode-${target}.${ext}`);
  const extractDir = join(BIN_DIR, `_extract-${target}`);
  rmSync(archive, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  await download(url, archive);
  await extract(archive, extractDir, target.startsWith('windows'));

  // The extracted tree contains bin/opencode[.exe] — locate and place it.
  const binaryName = target.startsWith('windows') ? 'opencode.exe' : 'opencode';
  const destDir = join(BIN_DIR, mapping.osDir, mapping.archDir);
  mkdirSync(destDir, { recursive: true });
  const found = findBinary(extractDir, binaryName);
  if (!found) throw new Error(`${binaryName} not found in archive for ${target}`);
  const dest = join(destDir, binaryName);
  rmSync(dest, { force: true });
  await run('cp', [found, dest]);
  if (!target.startsWith('windows')) chmodSync(dest, 0o755);
  log(`placed ${target} → ${dest}`);
  rmSync(archive, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

function findBinary(root, name) {
  const direct = join(root, 'bin', name);
  if (existsSync(direct)) return direct;
  if (existsSync(join(root, name))) return join(root, name);
  // Fallback: shallow recursive search for the exact filename.
  for (const entry of readdirRecursive(root)) {
    if (entry.split(/[/\\]/).pop() === name) return entry;
  }
  return undefined;
}

function readdirRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  const requested = process.env.OC_TARGETS ? process.env.OC_TARGETS.split(',').map((s) => s.trim()) : Object.keys(TARGETS);
  const targets = requested.filter((t) => TARGETS[t]);
  if (!targets.length) throw new Error(`No valid targets. Known: ${Object.keys(TARGETS).join(', ')}`);
  log(`fetching OC ${VERSION} for: ${targets.join(', ')}`);
  for (const t of targets) {
    try {
      await fetchTarget(t, TARGETS[t]);
    } catch (err) {
      // One platform failing (e.g. unzip missing) shouldn't abort the rest.
      console.error(`[fetch-opencode] ${t} failed: ${err.message}`);
    }
  }
  log('done. Layout:');
  log(`  ${BIN_DIR}/{macos,linux,windows}/{amd64,arm64}/opencode[.exe]`);
}

main().catch((err) => {
  console.error(`[fetch-opencode] fatal: ${err.message}`);
  process.exit(1);
});

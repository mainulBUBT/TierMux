#!/usr/bin/env node
/**
 * Downloads the latest OpenCode binary for the current platform.
 * Usage: node scripts/download-opencode.ts [version]
 * If no version is specified, it fetches the latest release.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const REPO = 'anomalyco/opencode';
const BIN_DIR = path.resolve(__dirname, '..', 'bin');

interface Release {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function platformAsset(): { name: string; arch: string } | null {
  const p = process.platform;
  const a = process.arch;

  if (p === 'darwin' && a === 'arm64') return { name: 'opencode-macos-arm64.tar.gz', arch: 'darwin/arm64' };
  if (p === 'darwin' && a === 'x64') return { name: 'opencode-macos-x64.tar.gz', arch: 'darwin/amd64' };
  if (p === 'linux' && a === 'arm64') return { name: 'opencode-linux-arm64.tar.gz', arch: 'linux/arm64' };
  if (p === 'linux' && a === 'x64') return { name: 'opencode-linux-x64.tar.gz', arch: 'linux/amd64' };
  if (p === 'win32' && a === 'x64') return { name: 'opencode-windows-x64.tar.gz', arch: 'win32/amd64' };
  return null;
}

async function main() {
  const asset = platformAsset();
  if (!asset) {
    console.error(`Unsupported platform: ${process.platform} ${process.arch}`);
    process.exit(1);
  }

  let version = process.argv[2];
  if (!version) {
    console.log('Fetching latest release...');
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    const release: Release = await res.json();
    version = release.tag_name;
    console.log(`Latest: ${version}`);
  }

  const destDir = path.join(BIN_DIR, asset.arch);
  const destPath = path.join(destDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');

  if (fs.existsSync(destPath)) {
    console.log(`Already exists: ${destPath}`);
    console.log('Delete it first to re-download.');
    process.exit(0);
  }

  const downloadUrl = `https://github.com/${REPO}/releases/download/${version}/${asset.name}`;
  console.log(`Downloading: ${downloadUrl}`);

  fs.mkdirSync(destDir, { recursive: true });

  const tarRes = await fetch(downloadUrl);
  if (!tarRes.ok) throw new Error(`Download failed: ${tarRes.status}`);

  const tarPath = path.join(os.tmpdir(), `opencode-${version}.tar.gz`);
  fs.writeFileSync(tarPath, Buffer.from(await tarRes.arrayBuffer()));

  fs.mkdirSync(path.join(os.tmpdir(), `opencode-extract`), { recursive: true });
  spawnSync('tar', ['xzf', tarPath, '-C', path.join(os.tmpdir(), `opencode-extract`)], { stdio: 'inherit' });

  // Find the binary
  const extractDir = path.join(os.tmpdir(), `opencode-extract`);
  const files = fs.readdirSync(extractDir, { recursive: true }) as string[];
  const binaryFile = files.find((f: string) => {
    const base = path.basename(f);
    return base === 'opencode' || base === 'opencode.exe';
  });

  if (binaryFile) {
    const srcPath = path.join(extractDir, binaryFile);
    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, 0o755);
    console.log(`Installed: ${destPath}`);
  } else {
    console.error('Binary not found in archive');
    process.exit(1);
  }

  // Cleanup
  fs.rmSync(tarPath, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('Failed to download OpenCode:', err.message);
  process.exit(1);
});

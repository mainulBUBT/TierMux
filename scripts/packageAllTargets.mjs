#!/usr/bin/env node
// Builds one platform-specific VSIX per ripgrep target. `vsce package --target`
// only stamps metadata — it does NOT filter node_modules — so each target's
// extra @vscode/ripgrep-* binaries must be force-installed then deleted down
// to just that target before packaging, otherwise every VSIX bundles every
// platform's binary (or, worse, the wrong one for the host that built it).
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RIPGREP_VERSION = '1.18.0';
const TARGETS = [
  ['darwin-arm64', '@vscode/ripgrep-darwin-arm64'],
  ['darwin-x64', '@vscode/ripgrep-darwin-x64'],
  ['win32-x64', '@vscode/ripgrep-win32-x64'],
  ['linux-x64', '@vscode/ripgrep-linux-x64'],
];

const outDir = 'dist-vsix';
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) rmSync(join(outDir, f));

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

for (const [target, pkg] of TARGETS) {
  console.log(`\n=== ${target} ===`);
  run('npm', ['install', '--no-save', '--force', `${pkg}@${RIPGREP_VERSION}`]);
  for (const entry of readdirSync('node_modules/@vscode')) {
    if (entry.startsWith('ripgrep-') && entry !== `ripgrep-${target}`) {
      rmSync(join('node_modules/@vscode', entry), { recursive: true, force: true });
    }
  }
  run('npx', ['vsce', 'package', '--target', target, '-o', `${outDir}/tiermux-${target}.vsix`]);
}

console.log('\nRestoring node_modules to lockfile-clean state...');
run('npm', ['install']);
console.log(`\nDone. Packages in ${outDir}/`);

if (process.argv.includes('--publish')) {
  if (!process.env.VSCE_PAT) throw new Error('VSCE_PAT is not set — required to publish to the VS Code Marketplace.');
  const vsixPaths = TARGETS.map(([target]) => `${outDir}/tiermux-${target}.vsix`);

  console.log('\nPublishing to VS Code Marketplace...');
  run('npx', ['vsce', 'publish', '--skip-duplicate', '-i', ...vsixPaths]);

  if (process.env.OVSX_PAT) {
    console.log('\nPublishing to Open VSX...');
    run('npx', ['ovsx', 'publish', '--skip-duplicate', '-i', ...vsixPaths, '-p', process.env.OVSX_PAT]);
  } else {
    console.log('\nOVSX_PAT not set — skipping Open VSX publish.');
  }
}

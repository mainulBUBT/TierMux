#!/usr/bin/env node
// Builds one platform-specific VSIX per ripgrep target. `vsce package --target`
// only stamps metadata — it does NOT filter node_modules — so each target's
// extra @vscode/ripgrep-* binaries must be force-installed then deleted down
// to just that target before packaging, otherwise every VSIX bundles every
// platform's binary (or, worse, the wrong one for the host that built it).
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RIPGREP_VERSION = '1.18.0';
// Shared with scripts/package-targets.sh. This list was private and had drifted to four
// entries, so `npm run publish:all` shipped no Linux ARM, Windows ARM or Alpine build at all
// while `package:all` shipped six — the reason it now lives in one file.
const { targets } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'release-targets.json'), 'utf8'),
);
const TARGETS = targets.map((t) => [t.target, `@vscode/ripgrep-${t.rg}`, t.rg]);

const outDir = 'dist-vsix';
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) rmSync(join(outDir, f));

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

for (const [target, pkg, rg] of TARGETS) {
  console.log(`\n=== ${target} (${pkg}) ===`);
  run('npm', ['install', '--no-save', '--force', `${pkg}@${RIPGREP_VERSION}`]);
  for (const entry of readdirSync('node_modules/@vscode')) {
    // Keep the RIPGREP package's directory, not one named after the target: lib/index.js
    // resolves `@vscode/ripgrep-${process.platform}-${process.arch}` at runtime, which is
    // linux-arm for linux-armhf and plain linux-* for both alpine targets. Comparing against
    // the target name deleted the very binary the VSIX needed.
    if (entry.startsWith('ripgrep-') && entry !== `ripgrep-${rg}`) {
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

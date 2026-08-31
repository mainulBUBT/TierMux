#!/usr/bin/env node
/**
 * Publish the per-target VSIXs in release/ to both marketplaces.
 *
 * Why this exists: a bare `vsce publish` packages from whatever is in node_modules right
 * now. This machine only has @vscode/ripgrep-darwin-arm64, so that single "universal" VSIX
 * ships a macOS-ARM binary to Windows and Linux users and crashes their activation — the
 * exact failure .github/workflows/package.yml was written to avoid. Platform-specific
 * extensions must be published one VSIX per target.
 *
 *   node scripts/publish-targets.mjs --dry-run   # show what would be published
 *   node scripts/publish-targets.mjs             # publish for real
 *
 * Needs: VSCE_PAT (or a prior `vsce login`) and OVSX_PAT in the environment.
 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'release');
const dry = process.argv.includes('--dry-run');
const version = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: ROOT, encoding: 'utf8' })).version;

const vsixes = readdirSync(DIR).filter((f) => f.endsWith('.vsix')).sort();
if (vsixes.length === 0) {
  console.error(`No .vsix in release/. Build them first (see scripts/package-targets.sh).`);
  process.exit(1);
}

// A VSIX whose version doesn't match package.json is a stale artifact from an earlier
// build — publishing it would ship the wrong code under the right version number.
const stale = vsixes.filter((f) => !f.includes(`-${version}-`));
if (stale.length) {
  console.error(`These VSIXs are not v${version} — rebuild before publishing:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}

console.log(`${dry ? '[dry run] ' : ''}Publishing v${version} — ${vsixes.length} targets:`);
for (const f of vsixes) console.log(`  ${f}`);

if (!dry) {
  for (const key of ['VSCE_PAT', 'OVSX_PAT']) {
    if (!process.env[key]) console.warn(`! ${key} is not set — that marketplace will fail`);
  }
}

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  if (!dry) execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
};

for (const f of vsixes) {
  const p = join('release', f);
  run('npx', ['vsce', 'publish', '--packagePath', p]);
  run('npx', ['ovsx', 'publish', p, '-p', process.env.OVSX_PAT ?? '']);
}
console.log(`\n${dry ? '[dry run] nothing was published.' : `v${version} published to both marketplaces.`}`);

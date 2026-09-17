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

/** The echoed command with the Open VSX token masked. `args.join(' ')` printed `-p <token>`
 *  verbatim on every run, dry runs included — the token then lives in scrollback, in CI logs and
 *  in any pasted output (leaked exactly that way on 2026-09-17). Masked here rather than dropped,
 *  so the echo still shows that a token WAS passed. */
const echo = (cmd, args) => {
  const shown = args.map((a, i) => (args[i - 1] === '-p' && a ? `${a.slice(0, 6)}…<redacted>` : a));
  console.log(`\n$ ${cmd} ${shown.join(' ')}`);
};

/** Run one publish. Returns the error instead of throwing: one marketplace being down must not
 *  cancel the other eight targets (Open VSX answered 503 mid-rollout on 2026-09-17 and took the
 *  whole run with it, leaving 1 of 9 targets on the Marketplace and nothing on Open VSX). */
const attempt = (label, cmd, args) => {
  echo(cmd, args);
  if (dry) return undefined;
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    return undefined;
  } catch (e) {
    console.error(`! ${label} FAILED — continuing`);
    return { label, message: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
};

// ONE MARKETPLACE AT A TIME, not interleaved per target: the two are independent services, and
// pairing them per target let an Open VSX outage block the Marketplace rollout as well.
// --skip-duplicate on both, so re-running after a partial rollout finishes it instead of dying
// on "already exists".
const failures = [];
console.log('\n── VS Code Marketplace ──');
for (const f of vsixes) {
  failures.push(attempt(`marketplace ${f}`, 'npx', ['vsce', 'publish', '--skip-duplicate', '--packagePath', join('release', f)]));
}
console.log('\n── Open VSX ──');
if (!dry && !process.env.OVSX_PAT) {
  console.warn('! OVSX_PAT is not set — skipping Open VSX entirely (nothing was attempted).');
} else {
  for (const f of vsixes) {
    failures.push(attempt(`open-vsx ${f}`, 'npx', ['ovsx', 'publish', '--skip-duplicate', join('release', f), '-p', process.env.OVSX_PAT ?? '']));
  }
}

const failed = failures.filter(Boolean);
if (dry) {
  console.log('\n[dry run] nothing was published.');
} else if (failed.length === 0) {
  console.log(`\nv${version} published to both marketplaces — ${vsixes.length} targets each.`);
} else {
  // Non-zero exit so CI notices, but every publish that COULD succeed already has: re-running
  // the script retries only what is still missing.
  console.error(`\nv${version}: ${failed.length} of ${vsixes.length * 2} publishes failed — re-run to retry just these:`);
  for (const f of failed) console.error(`  ${f.label} — ${f.message}`);
  process.exit(1);
}

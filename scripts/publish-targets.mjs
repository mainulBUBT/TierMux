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

/** execFileSync's Error message is "Command failed: <the whole argv>", so it carries the token
 *  even when the echo above masked it — the failure SUMMARY leaked it a second time on
 *  2026-09-17. Scrub any token-shaped argument out of arbitrary text before printing it. */
const scrub = (text) => String(text).replace(/(ovsxat_|-p\s+)[\w-]{8,}/g, (m, p1) => `${p1}<redacted>`);

/** Transient server-side refusals. Open VSX answered 503 to 5 of 9 uploads in one run
 *  (2026-09-17) while the other 4 went through — an overloaded service, not a bad request, so
 *  the same upload succeeds moments later. 429 is its rate limiter and behaves the same way. */
const TRANSIENT = /\b(429|500|502|503|504)\b|ETIMEDOUT|ECONNRESET|socket hang up/i;
/** Refusals no amount of waiting fixes. Retrying "Invalid access token" burned 110s of backoff
 *  per target — 16 minutes across nine — and could never have succeeded (2026-09-17). */
const PERMANENT = /invalid access token|unauthorized|forbidden|\b40[13]\b|not a member|publisher agreement/i;
const RETRIES = 4;
// Long, because the 503s are a RATE LIMIT, not an outage: Open VSX now runs "rate limiting tiers"
// (their own banner, 2026-09-17), which is why 9 back-to-back uploads got 5 refusals while 4 went
// through, and why the same rollout used to work when it was 4-6 targets.
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000];
/** Pause between consecutive Open VSX uploads, for the same reason — pacing avoids the refusal
 *  instead of recovering from it. The Marketplace has no such limit and is not paced. */
const OVSX_SPACING_MS = 20_000;
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);

/** Run one publish, retrying transient failures with backoff. Returns the error instead of
 *  throwing: one marketplace being down must not cancel the remaining targets (a 503 on the
 *  first target used to end the whole run, leaving 1 of 9 on the Marketplace and nothing on
 *  Open VSX). */
const attempt = (label, cmd, args) => {
  echo(cmd, args);
  if (dry) return undefined;
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      // stderr is PIPED, not inherited, purely so the retry decision can read WHY the upload
      // failed — execFileSync's own message is just "Command failed: <argv>". It is re-printed
      // below, so the operator still sees exactly what the tool said.
      execFileSync(cmd, args, { cwd: ROOT, stdio: ['inherit', 'inherit', 'pipe'] });
      if (i > 0) console.log(`  (succeeded on attempt ${i + 1})`);
      return undefined;
    } catch (e) {
      last = e;
      const toolSaid = scrub(e?.stderr?.toString?.() ?? '').trim();
      if (toolSaid) console.error(toolSaid);
      const why = toolSaid.split('\n')[0] || scrub(e instanceof Error ? e.message : e).split('\n')[0];
      // A permanent refusal must not be retried: waiting cannot make a rejected token valid,
      // and the backoff only delays the report the operator needs.
      if (PERMANENT.test(toolSaid)) {
        console.error(`! ${label} FAILED — permanent, not retrying`);
        return { label, message: why, permanent: true };
      }
      if (i < RETRIES && (TRANSIENT.test(toolSaid) || !toolSaid)) {
        const waitMs = BACKOFF_MS[i];
        console.error(`! ${label} failed (attempt ${i + 1}/${RETRIES + 1}) — retrying in ${waitMs / 1000}s`);
        // Synchronous sleep: this script is a sequential shell-out driver, and awaiting here
        // would mean restructuring every caller for no gain.
        sleep(waitMs);
        continue;
      }
      console.error(`! ${label} FAILED${i > 0 ? ` after ${i + 1} attempts` : ''} — continuing`);
      return { label, message: why };
    }
  }
  return { label, message: scrub(last).split('\n')[0] };
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
/** Is OVSX_PAT usable at all? Checked ONCE against the namespace before the pass, because an
 *  unusable token otherwise fails identically on every target — and the commonest cause is
 *  mundane: a trailing newline from `export OVSX_PAT=$(pbpaste)`, or a token copied short.
 *  Reports the token's shape so a truncated paste is visible without printing the token. */
const ovsxTokenUsable = () => {
  const pat = process.env.OVSX_PAT ?? '';
  console.log(`  token: ${pat.length} chars, starts "${pat.slice(0, 6)}"${/\s/.test(pat) ? ' — CONTAINS WHITESPACE, likely a bad paste' : ''}`);
  try {
    // verify-pat takes NO -p flag (only --help); it reads OVSX_PAT from the environment.
    execFileSync('npx', ['ovsx', 'verify-pat', 'mainul-islam'], {
      cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, OVSX_PAT: pat },
    });
    console.log('  token accepted for namespace "mainul-islam"');
    return true;
  } catch (e) {
    const said = scrub(`${e?.stdout?.toString?.() ?? ''}${e?.stderr?.toString?.() ?? ''}`).trim();
    console.error(`  token REJECTED — ${said.split('\n')[0] || 'verify-pat failed'}`);
    return false;
  }
};

if (!dry && !process.env.OVSX_PAT) {
  console.warn('! OVSX_PAT is not set — skipping Open VSX entirely (nothing was attempted).');
} else if (!dry && !ovsxTokenUsable()) {
  console.error('! Skipping Open VSX: the token was rejected, so all 9 uploads would fail the same way.');
  console.error('  Fix at https://open-vsx.org → Settings → Access Tokens (the namespace must be');
  console.error('  "mainul-islam" and the Eclipse publisher agreement signed), then re-run.');
  failures.push({ label: 'open-vsx (all targets)', message: 'OVSX_PAT rejected by verify-pat', permanent: true });
} else {
  vsixes.forEach((f, i) => {
    if (i > 0 && !dry) sleep(OVSX_SPACING_MS);
    failures.push(attempt(`open-vsx ${f}`, 'npx', ['ovsx', 'publish', '--skip-duplicate', join('release', f), '-p', process.env.OVSX_PAT ?? '']));
  });
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
  for (const f of failed) console.error(`  ${f.label} — ${scrub(f.message)}`);
  process.exit(1);
}

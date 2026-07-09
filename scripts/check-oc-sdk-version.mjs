#!/usr/bin/env node
// Guards against the two OC version pins drifting apart:
//   - scripts/fetch-opencode.mjs: PINNED_OC_VERSION (the vendored `opencode` binary)
//   - package.json: "@opencode-ai/sdk" (the typed client src/backend/ocClient.ts wraps)
//
// These MUST match exactly — the SDK's generated types describe that exact server
// version's API, and src/backend/ocClient.ts casts a couple of fields (agent/model on
// session create, permission on session update) past the SDK's declared types based on
// behavior empirically verified against 1.17.11 specifically. A version drift here is
// exactly the kind of silent-schema-mismatch bug this migration was meant to prevent
// (see the `code_execution` incident this replaced).
//
// Run automatically before `npm run typecheck` (wired as "pretypecheck"). To bump OC:
//   1. Update PINNED_OC_VERSION in scripts/fetch-opencode.mjs to the new version.
//   2. `npm install @opencode-ai/sdk@<same version> --save-exact`
//   3. Re-run the Phase 0 empirical check from the SDK migration (download the new
//      binary, spin up `opencode serve`, and confirm session.create/session.update
//      still accept the same agent/model/permission field shapes ocClient.ts sends —
//      see git history on src/backend/ocClient.ts for the verification script used).
//   4. `npm run typecheck` (this script runs first and will fail loudly if you forgot #2).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const fetchSrc = readFileSync(join(ROOT, 'scripts', 'fetch-opencode.mjs'), 'utf8');
const pinMatch = fetchSrc.match(/PINNED_OC_VERSION\s*=\s*'([^']+)'/);
if (!pinMatch) {
  console.error('[check-oc-sdk-version] could not find PINNED_OC_VERSION in scripts/fetch-opencode.mjs');
  process.exit(1);
}
const binaryVersion = pinMatch[1];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const sdkVersion = pkg.dependencies?.['@opencode-ai/sdk'];
if (!sdkVersion) {
  console.error('[check-oc-sdk-version] @opencode-ai/sdk is not in package.json dependencies');
  process.exit(1);
}

if (sdkVersion !== binaryVersion) {
  console.error(
    `[check-oc-sdk-version] OC version pins have drifted apart:\n` +
    `  scripts/fetch-opencode.mjs PINNED_OC_VERSION = ${binaryVersion}\n` +
    `  package.json "@opencode-ai/sdk"               = ${sdkVersion}\n` +
    `These must match exactly. See the comment at the top of this file for the upgrade steps.`
  );
  process.exit(1);
}

console.log(`[check-oc-sdk-version] OK — both pinned to ${binaryVersion}`);

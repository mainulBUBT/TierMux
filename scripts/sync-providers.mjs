// Keep src/providers/index.ts COMPAT array in sync with the remote /providers catalog.
//
//   node scripts/sync-providers.mjs                # dry run: report only
//   node scripts/sync-providers.mjs --apply        # rewrite src/providers/index.ts
//   node scripts/sync-providers.mjs <catalogUrl>   # override catalog url
//
// What it does:
//  - ADDS providers advertised by /providers that are not yet in COMPAT, tagged with a
//    trailing `// auto-synced` marker so future runs recognise them as managed.
//  - REMOVES `// auto-synced` entries that have disappeared from the remote catalog.
//
// Safety rails (it will NEVER do these):
//  - Never removes a hand-curated entry (no `// auto-synced` marker). openrouter, github,
//    zenmux, poolside, … stay even if the remote stops listing them — they carry curated
//    flags (reasoningStyle, extraHeaders, defaultMaxTokens) the remote doesn't know about.
//  - Never touches dedicated implementations (google, cloudflare) or cohere, which are
//    registered outside the COMPAT array.
//
// The marker convention is the whole safety contract: a human edits an entry → remove the
// marker (or never add it) → the script leaves it alone forever.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const INDEX_TS = join(root, 'src', 'providers', 'index.ts');
const TYPES_TS = join(root, 'src', 'shared', 'types.ts');
const AUTO_MARKER = 'auto-synced';

// Providers registered outside the COMPAT array — out of scope for this script.
const DEDICATED = new Set(['google', 'cloudflare', 'cohere']);

function defaultCatalogUrl() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg?.contributes?.configuration?.properties?.['tiermux.catalog.url']?.default ?? '';
}

// ---- arg parsing ----
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const urlArg = argv.find((a) => !a.startsWith('--'));
const url = urlArg || defaultCatalogUrl();
if (!url) {
  console.error('No catalog URL (pass one as argv, or set tiermux.catalog.url default in package.json).');
  process.exit(1);
}

/** Locate the COMPAT array body and return { headerText, entries, footerText }
 *  where each entry = { platform, raw, autoSynced, start, end } covering its full
 *  `{ … },` span INCLUDING any trailing comment. */
function parseCompatArray(src) {
  const openRe = /const COMPAT[^=]*=\s*\[/;
  const openMatch = openRe.exec(src);
  if (!openMatch) throw new Error('Could not find `const COMPAT … = [` in index.ts');
  const arrStart = openMatch.index + openMatch[0].length;

  // Find the matching closing `];` for the array (brace-aware).
  let depth = 1;
  let i = arrStart;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '/' && src[i + 1] === '/') {
      // skip line comment so `]` inside a comment doesn't confuse us
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    i++;
  }
  const arrEnd = i - 1; // index of the closing `]`

  const headerText = src.slice(0, arrStart);
  const body = src.slice(arrStart, arrEnd);
  const footerText = src.slice(arrEnd); // `];\n…`

  // Split body into top-level entries by balanced `{ … }` matching.
  const entries = [];
  let idx = 0;
  while (idx < body.length) {
    const braceStart = body.indexOf('{', idx);
    if (braceStart === -1) break;
    let d = 1;
    let j = braceStart + 1;
    while (j < body.length && d > 0) {
      const c = body[j];
      if (c === '{') d++;
      else if (c === '}') d--;
      j++;
    }
    const entryEnd = j; // just past the closing `}`
    // capture trailing comment + comma up to end-of-line
    let lineEnd = body.indexOf('\n', entryEnd);
    if (lineEnd === -1) lineEnd = body.length;
    const raw = body.slice(braceStart, lineEnd);
    const platformMatch = /platform:\s*['"]([^'"]+)['"]/.exec(raw);
    entries.push({
      platform: platformMatch ? platformMatch[1] : null,
      raw,
      autoSynced: raw.includes(AUTO_MARKER),
      // absolute offsets within `body` for surgical splice
      bodyStart: braceStart,
      bodyEnd: lineEnd,
    });
    idx = lineEnd;
  }
  return { headerText, body, footerText, entries };
}

/** Render a brand-new managed entry for a remote provider. */
function renderEntry(p) {
  const parts = [
    `platform: '${p.provider_id}'`,
    `name: ${JSON.stringify(p.display_name || p.provider_id)}`,
    `baseUrl: ${JSON.stringify(p.base_url)}`,
    // Match the defaults the runtime else-branch now applies to remote providers, so the
    // curated entry behaves identically whether or not the remote refresh fires.
    'skipPreflight: true',
    'timeoutMs: 600000',
  ];
  if (p.keyless === true) parts.push('keyless: true');
  if (p.key_url) parts.push(`keyUrl: ${JSON.stringify(p.key_url)}`);
  return `  { ${parts.join(', ')} }, // ${AUTO_MARKER}`;
}

async function main() {
  // ---- fetch remote ----
  let res;
  try {
    res = await fetch(url.replace(/\/+$/, '') + '/providers');
  } catch (e) {
    // Network failure is non-fatal: this script is wired into `npm run build`, so it must
    // never block the toolchain when the worker is unreachable.
    console.warn(`[sync-providers] network error fetching ${url}/providers — skipping (${e.message}).`);
    return;
  }
  if (!res.ok) {
    console.warn(`[sync-providers] /providers fetch failed: ${res.status} ${res.statusText} — skipping.`);
    return;
  }
  const json = await res.json();
  const remote = (json.providers || [])
    .filter((p) => p && p.provider_id && p.base_url && p.enabled !== false);
  const remoteIds = new Set(remote.map((p) => p.provider_id));

  // ---- parse current index.ts ----
  const src = readFileSync(INDEX_TS, 'utf8');
  const { headerText, body, footerText, entries } = parseCompatArray(src);

  const managed = entries.filter((e) => e.autoSynced);
  const curated = entries.filter((e) => !e.autoSynced);
  const hardcodedIds = new Set(
    entries.map((e) => e.platform).filter((id) => id && !DEDICATED.has(id)),
  );

  const toAdd = remote.filter(
    (p) => !hardcodedIds.has(p.provider_id) && !DEDICATED.has(p.provider_id),
  );
  const toRemove = managed.filter((e) => e.platform && !remoteIds.has(e.platform));

  // ---- report ----
  console.log(`Remote providers:   ${remote.length}  (${[...remoteIds].join(', ')})`);
  console.log(`Hardcoded COMPAT:   ${hardcodedIds.size}`);
  console.log(`  curated (kept):   ${curiedList(curated)}`);
  console.log(`  auto-synced:      ${managed.map((e) => e.platform).join(', ') || '(none)'}`);
  console.log('');
  console.log(`+ To add (${toAdd.length}):    ${toAdd.map((p) => p.provider_id).join(', ') || '(none)'}`);
  console.log(`- To remove (${toRemove.length}): ${toRemove.map((e) => e.platform).join(', ') || '(none)'}`);

  const curatedMissingRemote = curated
    .map((e) => e.platform)
    .filter((id) => id && !DEDICATED.has(id) && !remoteIds.has(id));
  if (curatedMissingRemote.length) {
    console.log('');
    console.log(`! Curated but NOT in remote (kept — remove marker manually to drop): ${curatedMissingRemote.join(', ')}`);
  }

  if (!apply) {
    console.log('');
    console.log('Dry run. Re-run with --apply to write changes to src/providers/index.ts.');
    return;
  }
  if (!toAdd.length && !toRemove.length) {
    console.log('Nothing to change.');
    return;
  }

  // ---- rebuild body ----
  // Keep the original body byte-for-byte (so indentation and leading comment blocks on
  // curated entries survive), only drop the lines of removed managed entries, then append
  // new managed entries on their own lines.
  const removeSet = new Set(toRemove.map((e) => e.platform));
  let bodyText = body.replace(/\n+$/, ''); // drop trailing blank lines
  let lines = bodyText.split('\n').filter((line) => {
    if (!line.includes(AUTO_MARKER)) return true; // curated / blank / comment — untouched
    const m = /platform:\s*['"]([^'"]+)['"]/.exec(line);
    return !(m && removeSet.has(m[1])); // drop only managed entries gone from remote
  });
  bodyText = lines.join('\n');
  if (toAdd.length) bodyText += '\n' + toAdd.map(renderEntry).join('\n');
  const newBody = bodyText + '\n';

  const next = headerText + newBody + footerText;
  writeFileSync(INDEX_TS, next, 'utf8');
  console.log('');
  console.log(`Wrote src/providers/index.ts — added ${toAdd.length}, removed ${toRemove.length}.`);

  // ---- keep src/shared/types.ts Platform union in step ----
  // A new provider only type-checks once its id is a member of `Platform`. Append any
  // newly added ids before the `| 'custom';` sentinel.
  if (toAdd.length) {
    const tsrc = readFileSync(TYPES_TS, 'utf8');
    const unionIds = new Set(
      [...tsrc.matchAll(/^\s*\|\s*'([^']+)'/gm)].map((m) => m[1]),
    );
    const missingTypes = toAdd.map((p) => p.provider_id).filter((id) => !unionIds.has(id));
    if (missingTypes.length) {
      const tnext = tsrc.replace(
        /^(\s*\|\s*'custom';)/m,
        missingTypes.map((id) => `  | '${id}'`).join('\n') + '\n$1',
      );
      writeFileSync(TYPES_TS, tnext, 'utf8');
      console.log(`Added ${missingTypes.length} Platform union member(s): ${missingTypes.join(', ')}`);
    }
  }
}

function curiedList(curated) {
  const ids = curated.map((e) => e.platform).filter(Boolean);
  return ids.length ? ids.join(', ') : '(none)';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

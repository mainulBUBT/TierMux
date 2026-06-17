#!/usr/bin/env node
// Propagate the display name from src/shared/branding.ts (PRODUCT_NAME) into the
// static manifest package.json, which VS Code reads before any code runs and so
// can't import the constant. Run after changing PRODUCT_NAME:  npm run rebrand
//
// Replaces only exact, quoted occurrences of the old display name (displayName,
// view title, command categories, submenu label, config title) — formatting and
// everything else in package.json is left untouched.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const brandingSrc = readFileSync(new URL('src/shared/branding.ts', root), 'utf8');
const match = brandingSrc.match(/PRODUCT_NAME\s*=\s*['"`](.+?)['"`]/);
if (!match) {
  console.error('rebrand: could not find PRODUCT_NAME in src/shared/branding.ts');
  process.exit(1);
}
const newName = match[1];

const pkgUrl = new URL('package.json', root);
const raw = readFileSync(pkgUrl, 'utf8');
const oldName = JSON.parse(raw).displayName;

if (oldName === newName) {
  console.log(`rebrand: package.json already shows "${newName}" — nothing to do.`);
  process.exit(0);
}

const from = JSON.stringify(oldName); // e.g. "Free LLM Agent" (quoted, escaped)
const to = JSON.stringify(newName);
const count = raw.split(from).length - 1;
writeFileSync(pkgUrl, raw.split(from).join(to));
console.log(`rebrand: package.json "${oldName}" → "${newName}" (${count} field${count === 1 ? '' : 's'}).`);
console.log('Note: command/config IDs (the "freeLlmAgent.*" prefix) are intentionally left unchanged.');

/**
 * projectProfile e2e — the auto-detected "This project" block injected into the system prompt.
 *
 * What it locks down: the block states only what was READ off disk. A framework hint appears
 * only after that framework's own signature file was found, and only names paths that exist —
 * the failure it replaces is a model orienting itself by guesswork (reading package.json in a
 * Laravel app and reasoning like it's Node, grepping the root for code that lives in a module).
 * Equally important: it stays SILENT for a folder with nothing to say.
 *
 * Run: npm run test:e2e:project-profile
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildProjectProfile } from '../src/context/projectProfile';

let pass = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-profile-'));

function fixture(name: string, files: Record<string, string | null>): string {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (body === null) { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

const LARAVEL = {
  'composer.json': JSON.stringify({ require: { php: '^8.1', 'laravel/framework': '^10.10' } }),
  'vendor/autoload.php': '<?php',
  artisan: '#!/usr/bin/env php',
  'phpunit.xml': '<phpunit/>',
  'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
  'app/Http/Controllers/HomeController.php': '<?php',
  'app/Models/User.php': '<?php',
  'resources/views/home.blade.php': '',
  'database/migrations/.gitkeep': '',
  'config/app.php': '<?php',
  'routes/web/shop.php': '<?php',
  'Modules/Blog/module.json': '{}',
  'Modules/Gateways/module.json': '{}',
  'tests/Feature/.gitkeep': '',
  'node_modules/.package-lock.json': '{}',
};

console.log('\n── 1. Laravel: framework, layout, modules, and the real check command ──');
{
  const md = buildProjectProfile(fixture('laravel', LARAVEL));
  assert(md.includes('Laravel 10.10'), 'names the framework and version from composer.json');
  assert(md.includes('PHP 8.1'), 'names the language from the manifest, not from file extensions');
  assert(md.includes('php artisan test'), 'the project check is the PHP suite, not the Vite build');
  assert(/Modules\/ holds 2 self-contained modules \(Blog, Gateways\)/.test(md), 'surfaces the modular layout with real module names');
  assert(md.includes('app/Http/Controllers') && md.includes('resources/views'), 'layout hint names real Laravel paths');
  assert(md.includes('route → controller'), 'says how a request flows through the framework');
  assert(!md.includes('node_modules') && !md.includes('vendor'), 'dependency trees never enter the map');
}

console.log('\n── 2. Hints never name a path this project does not have ──');
{
  // This app splits its routes into routes/web/*.php, so the conventional routes/web.php is a
  // path that does NOT exist here — naming it is exactly the guessing the block replaces.
  const md = buildProjectProfile(fixture('laravel-split-routes', LARAVEL));
  assert(!md.includes('routes/web.php'), 'the conventional file is dropped when absent');
  assert(/(^|[ ·])routes([ ·]|$)/m.test(md), 'the directory that DOES exist is named instead');
  const noServices = buildProjectProfile(fixture('laravel-no-services', LARAVEL));
  assert(!noServices.includes('app/Services'), 'an absent optional directory is never mentioned');
}

console.log('\n── 3. Other stacks get their own idiom ──');
{
  const django = buildProjectProfile(fixture('django', {
    'manage.py': '#!/usr/bin/env python', 'app/urls.py': '', 'app/models.py': '', 'tests': null, 'src': null, 'docs': null,
  }));
  assert(django.includes('Django') && django.includes('python manage.py test'), 'Django detected with its own check command');

  const next = buildProjectProfile(fixture('next', {
    'package.json': JSON.stringify({ dependencies: { next: '^14.2.3' }, scripts: { test: 'vitest run' } }),
    'node_modules/.package-lock.json': '{}', 'app/page.tsx': '', 'components': null, 'lib': null,
  }));
  assert(next.includes('Next.js 14') && next.includes('the URL path IS the file path'), 'Next.js detected with routing idiom');

  const go = buildProjectProfile(fixture('go', { 'go.mod': 'module x\n\ngo 1.22\n', cmd: null, internal: null, pkg: null }));
  assert(go.includes('Go 1.22') && go.includes('go test ./...'), 'Go version read from go.mod');
}

console.log('\n── 4. Nothing to say ⇒ no block at all ──');
{
  assert(buildProjectProfile(fixture('docs-only', { 'README.md': '# docs', 'plan/a.md': 'x' })) === '',
    'a docs folder produces no block (a one-line map is not worth the tokens)');
  assert(buildProjectProfile(path.join(tmpRoot, 'does-not-exist')) === '', 'unreadable root produces no block');
}

console.log('\n── 5. Budget: the block stays small enough to always afford ──');
{
  const md = buildProjectProfile(fixture('budget', LARAVEL));
  assert(md.length < 1400, `block is ~${Math.ceil(md.length / 4)} tokens (< 350)`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '✅' : '❌'} projectProfile e2e: ${pass} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

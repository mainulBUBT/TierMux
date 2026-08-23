/**
 * verifyDetect e2e — stack-wise verify-command detection (detectVerifyCommand).
 *
 * The bug this locks down: a Laravel app carrying a package.json for its Vite assets was
 * verified with `npm run build` (or, in a docs-only folder, nothing at all — which then told
 * the user their work was "Not tested yet" and asked them for a command). Detection must be
 * strength-ranked across ALL stacks present, and must stay SILENT (undefined) when the only
 * honest answer is "this project has no check I can run".
 *
 * Fixtures are built in a temp dir — no network, no installs, no real test runners invoked.
 *
 * Run: npm run test:e2e:verify-detect
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectVerifyCommand } from '../src/agent/core/tools/workspace/verifyCommand';

let pass = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-verify-detect-'));

/** Build a fixture workspace: keys are relative paths, values are file contents (a value of
 *  null means "empty directory"). */
function fixture(name: string, files: Record<string, string | null>): string {
  const root = path.join(tmpRoot, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (body === null) { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function expect(name: string, files: Record<string, string | null>, want: string | undefined): void {
  const got = detectVerifyCommand(fixture(name, files));
  assert(got === want, `${name}: ${JSON.stringify(got)} === ${JSON.stringify(want)}`);
}

console.log('\n── 1. Laravel: PHP test outranks the asset-pipeline build ──');
// The exact reported shape: composer + artisan + phpunit.xml + a package.json whose only
// script is `build`. The npm build proves the frontend compiles; it says nothing about the app.
expect('laravel', {
  'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }),
  'vendor/autoload.php': '<?php',
  artisan: '#!/usr/bin/env php',
  'phpunit.xml': '<phpunit/>',
  'tests/Feature/.gitkeep': '',
  'package.json': JSON.stringify({ scripts: { build: 'vite build', dev: 'vite' } }),
  'node_modules/.package-lock.json': '{}',
}, 'php artisan test');

console.log('\n── 2. The project\'s own composer script wins over a guessed runner ──');
expect('composer-script', {
  'composer.json': JSON.stringify({ scripts: { test: 'phpunit --colors' } }),
  'vendor/autoload.php': '<?php',
  artisan: '#!/usr/bin/env php',
  'phpunit.xml': '<phpunit/>',
}, 'composer test');

console.log('\n── 3. Dependencies not installed ⇒ withheld, not a command that can only fail ──');
expect('laravel-no-vendor', {
  'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }),
  artisan: '#!/usr/bin/env php',
  'phpunit.xml': '<phpunit/>',
}, undefined);
expect('node-no-modules', {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
}, undefined);

console.log('\n── 4. Node stays first-class ──');
expect('node-test', {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }),
  'node_modules/.package-lock.json': '{}',
}, 'npm test');
expect('node-pnpm-typecheck', {
  'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
  'pnpm-lock.yaml': 'lockfileVersion: 6.0',
  'node_modules/.modules.yaml': '',
}, 'pnpm run typecheck');
expect('node-placeholder-test', {
  'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }),
  'node_modules/.package-lock.json': '{}',
}, 'npm run build');

console.log('\n── 5. Other stacks, any language ──');
expect('go', { 'go.mod': 'module x' }, 'go test ./...');
expect('rust', { 'Cargo.toml': '[package]' }, 'cargo test');
expect('django', { 'manage.py': '#!/usr/bin/env python', 'tests': null }, 'python manage.py test');
expect('pytest', { 'pyproject.toml': '[tool.pytest.ini_options]\n' }, 'python -m pytest');
expect('rails-rspec', { Gemfile: 'source "x"', 'Gemfile.lock': '', '.rspec': '--color' }, 'bundle exec rspec');
expect('gradle-wrapper', { gradlew: '#!/bin/sh', 'build.gradle': '' }, './gradlew test');
expect('maven', { 'pom.xml': '<project/>' }, 'mvn -q test');
expect('dotnet', { 'App.sln': '' }, 'dotnet test');
expect('elixir', { 'mix.exs': 'defmodule' }, 'mix test');
expect('flutter', { 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n', 'test': null }, 'flutter test');
expect('swift', { 'Package.swift': '// swift-tools-version:5.9' }, 'swift test');
expect('make', { Makefile: 'test:\n\techo hi\n' }, 'make test');

console.log('\n── 6. Nothing detectable ⇒ undefined (the caller then stays quiet) ──');
expect('docs-only', { 'README.md': '# docs', 'notes/plan.md': 'x' }, undefined);
expect('empty', { '.keep': '' }, undefined);

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '✅' : '❌'} verifyDetect e2e: ${pass} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

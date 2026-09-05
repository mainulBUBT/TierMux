
// Verify command for the end-of-turn gate: LSP diagnostics prove the edited FILES parse, this
// proves the PROJECT works, and a non-zero exit feeds `agent.verifyFixRounds`. Detection is
// stack-wise, not Node-first (a Laravel app with a Vite package.json verifies with `php artisan
// test`): each stack contributes candidates by strength (test > typecheck > build) and the
// strongest wins; a stack without installed dependencies is withheld.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runShell } from '../shell';
import { effectiveRootUri } from '../workspaceRoot';

/** npm's scaffold placeholder — running it "fails" (exit 1) or "passes" (exit 0) while proving
 *  nothing, and treating either as a verification result would block/green-light real work on
 *  a project that simply has no tests. */
function isPlaceholderTestScript(script: string | undefined): boolean {
  if (!script) return true;
  const s = script.trim();
  return !s || /no test specified/i.test(s) || /^echo\b.*\bexit 1\b/.test(s) || /^exit 0$/.test(s);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** How much a candidate command actually proves. A real suite beats a static check beats a
 *  build — and the ranking is cross-stack, which is what keeps a Laravel repo's `npm run build`
 *  from shadowing its `php artisan test`. */
type Strength = 'test' | 'check' | 'build';
const STRENGTH_RANK: Record<Strength, number> = { test: 3, check: 2, build: 1 };

interface Candidate {
  command: string;
  strength: Strength;
}

/** Detector context: `root` plus cached existence lookups (each detector probes many paths). */
interface Ctx {
  root: string;
  has: (...rel: string[]) => boolean;
  json: (rel: string) => Record<string, unknown> | undefined;
  text: (rel: string) => string | undefined;
}

function makeCtx(root: string): Ctx {
  const seen = new Map<string, boolean>();
  const exists = (rel: string) => {
    let v = seen.get(rel);
    if (v === undefined) { v = fs.existsSync(path.join(root, rel)); seen.set(rel, v); }
    return v;
  };
  return {
    root,
    has: (...rel) => rel.some(exists),
    json: (rel) => (exists(rel) ? readJson(path.join(root, rel)) : undefined),
    text: (rel) => (exists(rel) ? readText(path.join(root, rel)) : undefined),
  };
}

/** Script-name preference shared by every manifest that has named scripts: a real suite first,
 *  then anything that at least proves it compiles, then the build. */
const CHECK_SCRIPTS = ['typecheck', 'type-check', 'check', 'lint', 'analyse', 'analyze', 'phpstan', 'psalm', 'stan'];

// ── Per-stack detectors ────────────────────────────────────────────────────────────────
// Each returns the best command IT can vouch for, or undefined. Order in DETECTORS only
// breaks ties between equally strong candidates; it never overrides strength.

/** JS/TS: package.json scripts, run through whichever package manager the repo actually uses.
 *  Withheld when dependencies aren't installed — `npm test` on a fresh clone fails for reasons
 *  that have nothing to do with the agent's edits. */
function detectNode(c: Ctx): Candidate | undefined {
  const pkg = c.json('package.json');
  if (!pkg) return undefined;
  const installed = c.has('node_modules', '.pnp.cjs', '.pnp.js', '.yarn');
  if (!installed) return undefined;
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string | undefined>;
  const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  const runner = /pnpm/i.test(pm) || c.has('pnpm-lock.yaml') ? 'pnpm'
    : /bun/i.test(pm) || c.has('bun.lockb', 'bun.lock') ? 'bun'
      : /yarn/i.test(pm) || c.has('yarn.lock') ? 'yarn' : 'npm';
  if (!isPlaceholderTestScript(scripts.test)) return { command: `${runner} test`, strength: 'test' };
  for (const k of CHECK_SCRIPTS) if (scripts[k]) return { command: `${runner} run ${k}`, strength: 'check' };
  if (scripts.build) return { command: `${runner} run build`, strength: 'build' };
  return undefined;
}

/** Deno: task-based, no install step to check. */
function detectDeno(c: Ctx): Candidate | undefined {
  const cfg = c.json('deno.json') ?? c.json('deno.jsonc');
  if (!cfg) return undefined;
  const tasks = (cfg.tasks && typeof cfg.tasks === 'object' ? cfg.tasks : {}) as Record<string, unknown>;
  if (tasks.test) return { command: 'deno task test', strength: 'test' };
  for (const k of ['check', 'typecheck', 'lint']) if (tasks[k]) return { command: `deno task ${k}`, strength: 'check' };
  return undefined;
}

/** PHP — Laravel/Symfony/plain Composer. Everything here needs an installed vendor/ tree, so
 *  the whole stack is withheld without one. `composer test` (the project's own declared entry
 *  point) outranks a guessed runner; Laravel's `php artisan test` outranks a bare phpunit call
 *  because it boots the framework's own test environment. */
function detectPhp(c: Ctx): Candidate | undefined {
  const composer = c.json('composer.json');
  const hasVendor = c.has('vendor/autoload.php');
  if (!composer && !c.has('artisan')) return undefined;
  if (!hasVendor) return undefined;
  const scripts = (composer?.scripts && typeof composer.scripts === 'object' ? composer.scripts : {}) as Record<string, unknown>;
  const phpunitCfg = c.has('phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml');
  if (scripts.test) return { command: 'composer test', strength: 'test' };
  if (c.has('artisan') && (phpunitCfg || c.has('tests'))) return { command: 'php artisan test', strength: 'test' };
  if (c.has('vendor/bin/pest') && (c.has('tests') || c.has('Pest.php', 'tests/Pest.php'))) {
    return { command: './vendor/bin/pest', strength: 'test' };
  }
  if (phpunitCfg && c.has('vendor/bin/phpunit')) return { command: './vendor/bin/phpunit', strength: 'test' };
  for (const k of CHECK_SCRIPTS) if (scripts[k]) return { command: `composer run ${k}`, strength: 'check' };
  if (c.has('vendor/bin/phpstan') && c.has('phpstan.neon', 'phpstan.neon.dist')) {
    return { command: './vendor/bin/phpstan analyse --no-progress', strength: 'check' };
  }
  return undefined;
}

/** Python: the project's declared runner first (tox), then Django's own test command, then
 *  pytest when the repo is configured for it. */
function detectPython(c: Ctx): Candidate | undefined {
  if (c.has('tox.ini')) return { command: 'tox', strength: 'test' };
  if (c.has('manage.py') && c.has('tests', 'test')) return { command: 'python manage.py test', strength: 'test' };
  const pyproject = c.text('pyproject.toml');
  if (c.has('pytest.ini') || (pyproject && /\[tool\.pytest/.test(pyproject))) {
    return { command: 'python -m pytest', strength: 'test' };
  }
  if (c.has('tests') && (pyproject || c.has('setup.py', 'setup.cfg', 'requirements.txt'))) {
    return { command: 'python -m pytest', strength: 'test' };
  }
  if (pyproject) return { command: 'python -m compileall -q .', strength: 'check' };
  return undefined;
}

/** Ruby: rspec when the repo has specs, otherwise the Rake test task. */
function detectRuby(c: Ctx): Candidate | undefined {
  const bundled = c.has('Gemfile.lock');
  const prefix = c.has('Gemfile') && bundled ? 'bundle exec ' : '';
  if (c.has('.rspec') || c.has('spec')) return { command: `${prefix}rspec`, strength: 'test' };
  const rake = c.text('Rakefile');
  if (rake && /(task\s+:test|Rake::TestTask)/.test(rake)) return { command: `${prefix}rake test`, strength: 'test' };
  return undefined;
}

function detectRust(c: Ctx): Candidate | undefined {
  return c.has('Cargo.toml') ? { command: 'cargo test', strength: 'test' } : undefined;
}

function detectGo(c: Ctx): Candidate | undefined {
  return c.has('go.mod') ? { command: 'go test ./...', strength: 'test' } : undefined;
}

/** JVM: the wrapper script when the repo ships one (it pins the toolchain version). */
function detectJvm(c: Ctx): Candidate | undefined {
  if (c.has('gradlew')) return { command: './gradlew test', strength: 'test' };
  if (c.has('build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts')) {
    return { command: 'gradle test', strength: 'test' };
  }
  if (c.has('mvnw')) return { command: './mvnw -q test', strength: 'test' };
  if (c.has('pom.xml')) return { command: 'mvn -q test', strength: 'test' };
  return undefined;
}

function detectDotnet(c: Ctx): Candidate | undefined {
  const entries = (() => { try { return fs.readdirSync(c.root); } catch { return [] as string[]; } })();
  if (entries.some((f) => f.endsWith('.sln') || f.endsWith('.csproj') || f.endsWith('.fsproj'))) {
    return { command: 'dotnet test', strength: 'test' };
  }
  return undefined;
}

function detectElixir(c: Ctx): Candidate | undefined {
  return c.has('mix.exs') ? { command: 'mix test', strength: 'test' } : undefined;
}

/** Dart vs Flutter — the wrong runner errors out immediately, so read the manifest. */
function detectDart(c: Ctx): Candidate | undefined {
  const pubspec = c.text('pubspec.yaml');
  if (!pubspec) return undefined;
  if (!c.has('test')) return undefined;
  return /^\s*(flutter|sdk:\s*flutter)/m.test(pubspec)
    ? { command: 'flutter test', strength: 'test' }
    : { command: 'dart test', strength: 'test' };
}

function detectSwift(c: Ctx): Candidate | undefined {
  return c.has('Package.swift') ? { command: 'swift test', strength: 'test' } : undefined;
}

function detectZig(c: Ctx): Candidate | undefined {
  return c.has('build.zig') ? { command: 'zig build test', strength: 'test' } : undefined;
}

function detectHaskell(c: Ctx): Candidate | undefined {
  if (c.has('stack.yaml')) return { command: 'stack test', strength: 'test' };
  const entries = (() => { try { return fs.readdirSync(c.root); } catch { return [] as string[]; } })();
  return entries.some((f) => f.endsWith('.cabal')) ? { command: 'cabal test', strength: 'test' } : undefined;
}

/** CTest, but only against an already-configured build tree — configuring one from scratch is
 *  not a verification step. */
function detectCMake(c: Ctx): Candidate | undefined {
  for (const dir of ['build', 'out/build', 'cmake-build-debug']) {
    if (c.has(`${dir}/CTestTestfile.cmake`)) return { command: `ctest --test-dir ${dir} --output-on-failure`, strength: 'test' };
  }
  return undefined;
}

/** Make: last, and only for targets that mean what they say. */
function detectMake(c: Ctx): Candidate | undefined {
  for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
    const body = c.text(mk);
    if (!body) continue;
    if (/^test:/m.test(body)) return { command: 'make test', strength: 'test' };
    if (/^check:/m.test(body)) return { command: 'make check', strength: 'check' };
  }
  return undefined;
}

const DETECTORS: Array<(c: Ctx) => Candidate | undefined> = [
  detectNode, detectDeno, detectPhp, detectPython, detectRuby, detectRust, detectGo,
  detectJvm, detectDotnet, detectElixir, detectDart, detectSwift, detectZig, detectHaskell,
  detectCMake, detectMake,
];

/** Zero-LLM detection of the one command that proves this project still works: every stack
 *  present is asked and the strongest candidate wins. Undefined when nothing trustworthy exists —
 *  the caller then skips the gate quietly rather than running a guess. */
export function detectVerifyCommand(root: string): string | undefined {
  const c = makeCtx(root);
  let best: Candidate | undefined;
  for (const detect of DETECTORS) {
    let cand: Candidate | undefined;
    try { cand = detect(c); } catch { cand = undefined; }
    if (!cand) continue;
    if (!best || STRENGTH_RANK[cand.strength] > STRENGTH_RANK[best.strength]) best = cand;
    if (best.strength === 'test') break; // nothing outranks a real suite
  }
  return best?.command;
}

/** Resolves the verify command for THIS turn: an explicit `tiermux.agent.verifyCommand` value
 *  wins ('off' disables, 'auto'/empty auto-detects), otherwise auto-detect from the workspace
 *  manifest. Returns undefined when verification is off or nothing detectable exists. */
export function resolveVerifyCommand(): string | undefined {
  const setting = vscode.workspace.getConfiguration('tiermux.agent').get<string>('verifyCommand', 'auto');
  const v = setting.trim();
  if (!v || v.toLowerCase() === 'auto') {
    try { return detectVerifyCommand(effectiveRootUri().fsPath); } catch { return undefined; }
  }
  if (v.toLowerCase() === 'off') return undefined;
  return v;
}

export interface VerifyRun {
  /** true = exit 0; false = non-zero exit; null = could not run (declined/disabled/timed out/
   *  errored before producing an exit status) — the caller treats null as "no signal", never
   *  as a failure. */
  ok: boolean | null;
  output: string;
}

/** Runs the verify command as a fresh one-shot spawn at the workspace root. Not gated by the
 *  approval policy — it fires only after the agent already mutated the workspace under that
 *  policy, and the command comes from the project manifest or the user's setting — but
 *  `commandApproval: 'never'` still switches it off. */
export async function runVerifyCommand(command: string): Promise<VerifyRun> {
  try {
    if (vscode.workspace.getConfiguration('tiermux.agent').get<string>('commandApproval', 'always') === 'never') {
      return { ok: null, output: 'Command execution is disabled (tiermux.agent.commandApproval = "never").' };
    }
    const res = await runShell(command, { cwd: effectiveRootUri().fsPath, timeoutMs: 120_000 });
    const output = ((res.error ? res.error + '\n' : '') + res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
    if (res.exitCode === null) return { ok: null, output };
    return { ok: res.exitCode === 0, output };
  } catch (e) {
    return { ok: null, output: e instanceof Error ? e.message : String(e) };
  }
}

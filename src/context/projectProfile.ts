// Deterministic project profile — the few facts about THIS workspace that decide where an
// agent should look first, computed in TypeScript and handed to the model in the system prompt.
//
// Why it exists: the research methodology in `.tiermux/agent/research.md` is stack-agnostic on
// purpose ("search before read", tool order, budget) — it tells the model HOW to look but never
// WHAT it is looking at. Dropped into an unfamiliar stack the model has to rediscover the
// obvious every turn, and it guesses badly: in a Laravel app it reads package.json, sees Vite,
// and reasons like it's a Node project; it greps the repo root for a controller that lives under
// `Modules/<Name>/app/Http/Controllers`; it proposes `npm test` for a project whose suite is
// `php artisan test`. Every one of those is a wasted call (or a wrong answer) on a question a
// directory listing already answers.
//
// The rule this module follows: state only what was READ off disk — manifests, entry points,
// directories that actually exist — never what a framework "usually" looks like. Layout hints
// are emitted per framework, but only after that framework's own signature file was found, and
// only naming paths that exist. A stack we don't recognize still gets the generic half (top-level
// map, manifests, verify command), which is strictly better than nothing and never misleading.
//
// Cost discipline: ~120-220 tokens, rebuilt only when the root's manifests/layout actually
// change (stamp cache), and skipped entirely for trivial turns by the caller. It pays for itself
// the first time it replaces one `list`+`grep` orientation round-trip.

import * as fs from 'fs';
import * as path from 'path';
import { detectVerifyCommand } from '../agent/core/tools/workspace/verifyCommand';

/** Directories that say nothing about the project's shape — dependency trees, build output, VCS
 *  and editor metadata. Listing them wastes the map's budget and invites the model to read them. */
const NOISE_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', '.git', '.svn', '.hg', '.idea',
  '.vscode', '.vs', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.dart_tool',
  'bower_components', 'coverage', '.cache', '.turbo', '.parcel-cache', 'tmp', 'temp', 'logs',
  'bin', 'obj', '.terraform', '.pytest_cache', '.mypy_cache', '.tox',
]);

const MAX_DIRS = 14;

interface Ctx {
  root: string;
  /** Top-level entry names (files and dirs), read once. */
  entries: string[];
  dirs: string[];
  has: (...rel: string[]) => boolean;
  text: (rel: string) => string | undefined;
  json: (rel: string) => Record<string, unknown> | undefined;
}

function makeCtx(root: string): Ctx | undefined {
  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(root, { withFileTypes: true }); } catch { return undefined; }
  const entries = dirents.map((d) => d.name);
  const dirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NOISE_DIRS.has(d.name)).map((d) => d.name);
  const cache = new Map<string, string | undefined>();
  const text = (rel: string): string | undefined => {
    if (!cache.has(rel)) {
      try { cache.set(rel, fs.readFileSync(path.join(root, rel), 'utf8')); } catch { cache.set(rel, undefined); }
    }
    return cache.get(rel);
  };
  return {
    root,
    entries,
    dirs,
    has: (...rel) => rel.some((r) => fs.existsSync(path.join(root, r))),
    text,
    json: (rel) => { const t = text(rel); if (!t) return undefined; try { return JSON.parse(t); } catch { return undefined; } },
  };
}

/** First capture group of the first match, trimmed — or undefined. */
function grab(body: string | undefined, re: RegExp): string | undefined {
  const m = body?.match(re);
  return m?.[1]?.trim();
}

/** A dependency's declared version from a JSON manifest's dependency maps. */
function depVersion(pkg: Record<string, unknown> | undefined, name: string): string | undefined {
  for (const key of ['dependencies', 'devDependencies', 'require', 'require-dev', 'peerDependencies']) {
    const map = pkg?.[key];
    if (map && typeof map === 'object' && typeof (map as Record<string, unknown>)[name] === 'string') {
      return (map as Record<string, string>)[name];
    }
  }
  return undefined;
}

/** Version strings arrive as ranges (`^11.9`, `~4.2.0`, `>=1.21`); the major is the only part
 *  worth spending prompt space on. */
function major(v: string | undefined): string | undefined {
  const m = v?.match(/(\d+(?:\.\d+)?)/);
  return m?.[1];
}

// ── Framework signatures ───────────────────────────────────────────────────────────────
// Each entry fires ONLY on a file/dependency that framework actually installs, and its hint
// names paths filtered against what exists on disk (see keepExisting).

interface Framework {
  /** Rendered stack label, e.g. "Laravel 11". */
  label: (c: Ctx) => string;
  detect: (c: Ctx) => boolean;
  /** Candidate "start here" paths, in the order a request usually flows through them. */
  path: string[];
  /** One line telling the model how a request travels through this framework's code. */
  flow: string;
}

const FRAMEWORKS: Framework[] = [
  {
    detect: (c) => c.has('artisan') && !!depVersion(c.json('composer.json'), 'laravel/framework'),
    label: (c) => `Laravel${major(depVersion(c.json('composer.json'), 'laravel/framework')) ? ' ' + major(depVersion(c.json('composer.json'), 'laravel/framework')) : ''}`,
    path: ['routes/web.php', 'routes/api.php', 'routes', 'app/Http/Controllers', 'app/Models', 'app/Services', 'resources/views', 'database/migrations', 'config'],
    flow: 'a request goes route → controller → model/service → Blade view; `php artisan route:list` resolves any route to its controller',
  },
  {
    detect: (c) => c.has('bin/console') && !!depVersion(c.json('composer.json'), 'symfony/framework-bundle'),
    label: (c) => `Symfony${major(depVersion(c.json('composer.json'), 'symfony/framework-bundle')) ? ' ' + major(depVersion(c.json('composer.json'), 'symfony/framework-bundle')) : ''}`,
    path: ['config/routes.yaml', 'src/Controller', 'src/Entity', 'src/Service', 'templates'],
    flow: 'a request goes route → controller → entity/service → Twig template; `bin/console debug:router` lists routes',
  },
  {
    detect: (c) => c.has('wp-config.php') || c.has('wp-content'),
    label: () => 'WordPress',
    path: ['wp-content/themes', 'wp-content/plugins', 'functions.php'],
    flow: 'behavior lives in the active theme and in plugins, wired through hooks (`add_action`/`add_filter`) — grep the hook name, not the page',
  },
  {
    detect: (c) => c.has('manage.py'),
    label: () => 'Django',
    path: ['urls.py', 'settings.py', 'models.py', 'views.py'],
    flow: 'a request goes urls.py → view → model → template, per installed app; `python manage.py showmigrations` reflects DB state',
  },
  {
    detect: (c) => c.has('config/routes.rb') || c.has('bin/rails'),
    label: () => 'Rails',
    path: ['config/routes.rb', 'app/controllers', 'app/models', 'app/views', 'db/migrate'],
    flow: 'a request goes routes.rb → controller → model → view; `bin/rails routes` resolves any route',
  },
  {
    detect: (c) => !!depVersion(c.json('package.json'), 'next'),
    label: (c) => `Next.js${major(depVersion(c.json('package.json'), 'next')) ? ' ' + major(depVersion(c.json('package.json'), 'next')) : ''}`,
    path: ['app', 'pages', 'src/app', 'src/pages', 'components', 'lib'],
    flow: 'routing is the directory structure under app/ (or pages/) — the URL path IS the file path',
  },
  {
    detect: (c) => !!depVersion(c.json('package.json'), 'nuxt') || !!depVersion(c.json('package.json'), 'nuxt3'),
    label: () => 'Nuxt',
    path: ['pages', 'components', 'composables', 'server/api'],
    flow: 'routing is the file tree under pages/; server routes live under server/api',
  },
  {
    detect: (c) => !!depVersion(c.json('package.json'), '@nestjs/core'),
    label: () => 'NestJS',
    path: ['src/main.ts', 'src/app.module.ts', 'src'],
    flow: 'a request goes module → controller → service; the module graph in *.module.ts is the map',
  },
  {
    detect: (c) => !!depVersion(c.json('package.json'), '@angular/core'),
    label: () => 'Angular',
    path: ['src/app', 'src/main.ts'],
    flow: 'components/services under src/app, wired through NgModules or standalone imports',
  },
  {
    detect: (c) => !!depVersion(c.json('package.json'), 'express') || !!depVersion(c.json('package.json'), 'fastify'),
    label: (c) => (depVersion(c.json('package.json'), 'express') ? 'Express' : 'Fastify'),
    path: ['src/routes', 'routes', 'src/index.ts', 'src/app.ts', 'index.js', 'server.js'],
    flow: 'routes are registered in code — grep the URL literal to find its handler',
  },
  {
    detect: (c) => !!depVersion(c.json('package.json'), 'fastapi') || (c.text('requirements.txt')?.includes('fastapi') ?? false)
      || (c.text('pyproject.toml')?.includes('fastapi') ?? false),
    label: () => 'FastAPI',
    path: ['app/main.py', 'main.py', 'app/api', 'app/models'],
    flow: 'routes are decorators (`@app.get`) — grep the path literal to find its handler',
  },
  {
    detect: (c) => !!depVersion(c.json('package.json'), 'vscode') || (!!c.json('package.json')?.contributes && !!c.json('package.json')?.engines),
    label: () => 'VS Code extension',
    path: ['src/extension.ts', 'package.json'],
    flow: 'package.json `contributes`/`activationEvents` is the contract; commands are registered in the activate() function',
  },
  {
    detect: (c) => (c.text('pom.xml')?.includes('spring-boot') ?? false) || (c.text('build.gradle')?.includes('org.springframework.boot') ?? false),
    label: () => 'Spring Boot',
    path: ['src/main/java', 'src/main/resources/application.yml', 'src/main/resources/application.properties'],
    flow: 'annotations wire it up — grep `@RestController`/`@Service` rather than following imports',
  },
  {
    detect: (c) => (c.text('pubspec.yaml')?.match(/^\s*flutter:/m) ?? null) !== null,
    label: () => 'Flutter',
    path: ['lib/main.dart', 'lib'],
    flow: 'everything starts at lib/main.dart; widgets compose downward from there',
  },
];

/** Base language/runtime facts, keyed off manifests only (never file extensions — a Laravel repo
 *  is full of .js and that is not what it IS). */
function languageFacts(c: Ctx): string[] {
  const facts: string[] = [];
  const composer = c.json('composer.json');
  if (composer) {
    const php = major(depVersion(composer, 'php'));
    facts.push(`PHP${php ? ' ' + php : ''} (composer.json)`);
  }
  const pkg = c.json('package.json');
  if (pkg) {
    const pm = typeof pkg.packageManager === 'string' ? String(pkg.packageManager).split('@')[0]
      : c.has('pnpm-lock.yaml') ? 'pnpm' : c.has('yarn.lock') ? 'yarn' : c.has('bun.lockb', 'bun.lock') ? 'bun' : 'npm';
    facts.push(`Node/${pm} (package.json)`);
  }
  const goMod = c.text('go.mod');
  if (goMod) facts.push(`Go${grab(goMod, /^go\s+(\d+\.\d+)/m) ? ' ' + grab(goMod, /^go\s+(\d+\.\d+)/m) : ''} (go.mod)`);
  if (c.has('Cargo.toml')) facts.push('Rust (Cargo.toml)');
  if (c.has('pyproject.toml', 'requirements.txt', 'setup.py')) facts.push('Python');
  if (c.has('Gemfile')) facts.push('Ruby (Gemfile)');
  if (c.has('pom.xml')) facts.push('Java/Maven (pom.xml)');
  if (c.has('build.gradle', 'build.gradle.kts')) facts.push('JVM/Gradle');
  if (c.has('mix.exs')) facts.push('Elixir (mix.exs)');
  if (c.has('pubspec.yaml')) facts.push('Dart (pubspec.yaml)');
  if (c.has('Package.swift')) facts.push('Swift (Package.swift)');
  if (c.entries.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) facts.push('.NET');
  return facts;
}

/** Keep only the candidate paths that actually exist — a hint naming a directory this project
 *  doesn't have is exactly the guessing this module replaces. A bare directory candidate is
 *  dropped when a more specific path under it survived (`routes/web.php` says more than
 *  `routes`), which is what lets a framework list both the conventional file AND the fallback
 *  directory for projects that split it up (6valley's Laravel routes live in `routes/web/`). */
function keepExisting(c: Ctx, candidates: string[]): string[] {
  const kept = candidates.filter((p) => c.has(p));
  return kept.filter((p) => !kept.some((other) => other !== p && other.startsWith(p + '/')));
}

/** Modular monoliths hide the real code one level down (nwidart/laravel-modules, Symfony bundles,
 *  Nx/Turbo packages). Without this the model greps the root layout forever. */
function moduleNote(c: Ctx): string | undefined {
  for (const dir of ['Modules', 'modules', 'packages', 'apps', 'services']) {
    if (!c.dirs.includes(dir)) continue;
    let children: string[] = [];
    try {
      children = fs.readdirSync(path.join(c.root, dir), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    } catch { /* unreadable — fall through to the plain mention */ }
    if (!children.length) continue;
    const shown = children.slice(0, 8).join(', ');
    return `${dir}/ holds ${children.length} self-contained module${children.length === 1 ? '' : 's'} (${shown}${children.length > 8 ? ', …' : ''}) — a feature's code may live in its module rather than the root app tree`;
  }
  return undefined;
}

/** The prompt block, or '' when there is nothing worth saying (an empty or unreadable folder). */
export function buildProjectProfile(root: string): string {
  const c = makeCtx(root);
  if (!c) return '';

  const langs = languageFacts(c);
  const fw = FRAMEWORKS.filter((f) => { try { return f.detect(c); } catch { return false; } });
  const stack = [...fw.map((f) => f.label(c)), ...langs];
  const map = c.dirs.slice(0, MAX_DIRS);
  // No manifest and almost no structure (a docs folder, a scratch directory): a bare one-line
  // map plus the framing paragraph would cost tokens to say nothing. Stay silent instead.
  if (!stack.length && map.length < 3) return '';

  const lines: string[] = [];
  if (stack.length) lines.push(`- Stack: ${stack.join(' · ')}`);
  if (map.length) lines.push(`- Top-level: ${map.join(', ')}${c.dirs.length > MAX_DIRS ? `, +${c.dirs.length - MAX_DIRS} more` : ''}`);
  const mods = moduleNote(c);
  if (mods) lines.push(`- Modules: ${mods}`);
  for (const f of fw.slice(0, 2)) {
    const paths = keepExisting(c, f.path);
    if (paths.length) lines.push(`- ${f.label(c)} layout: ${paths.join(' · ')} — ${f.flow}`);
  }
  let verify: string | undefined;
  try { verify = detectVerifyCommand(root); } catch { verify = undefined; }
  if (verify) lines.push(`- Project check: \`${verify}\` (the command that proves this project still works)`);
  if (!lines.length) return '';

  return '## This project (auto-detected from disk — facts, not guesses)\n'
    + lines.join('\n')
    + '\nUse this to aim your FIRST search instead of scanning the repo, and to pick the right '
    + 'language/framework idiom. It is a map, not evidence: still read the actual file before '
    + 'you change or describe it, and never assume anything not listed here exists.';
}

/** Stamp of the inputs the profile is derived from: the root directory itself (its mtime moves
 *  when a top-level entry is added/removed) plus the manifests whose CONTENT the profile reads. */
const STAMP_SOURCES = [
  '.', 'composer.json', 'package.json', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'pubspec.yaml', 'Cargo.toml', 'mix.exs',
];

function profileStamp(root: string): string {
  return STAMP_SOURCES.map((rel) => {
    try { const s = fs.statSync(path.join(root, rel)); return `${s.mtimeMs}:${s.size}`; } catch { return ''; }
  }).join('|');
}

const profileCache = new Map<string, { stamp: string; block: string }>();

/** Cached entry point for prompt assembly: recomputed only when the workspace's manifests or
 *  top-level layout actually move, so a long session pays the directory reads once. */
export function projectProfilePrompt(root: string | undefined): string {
  if (!root) return '';
  const stamp = profileStamp(root);
  const hit = profileCache.get(root);
  if (hit && hit.stamp === stamp) return hit.block;
  let block = '';
  try { block = buildProjectProfile(root); } catch { block = ''; }
  profileCache.set(root, { stamp, block });
  return block;
}

// Builds a cheap project-identity summary (name, type, README excerpt, shape)
// injected into the system prompt so the agent knows what project it's in — the
// difference between "I'm an AI assistant" and "I'm working in your <name>
// <type> project". Mirrors loadProjectRules: fs read + decode + char cap.
import * as vscode from 'vscode';
import { buildRepoMapSummary } from '../agent/repoMap';

const MAX_CHARS = 2000;

interface ProjectInfo { name: string; type: string; stack?: string }

async function readText(root: vscode.Uri, rel: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel)));
  } catch {
    return undefined; // not present
  }
}

/** Detect project name + type from the first recognized manifest. */
async function detectProject(root: vscode.Uri, fallbackName: string): Promise<ProjectInfo> {
  const composer = await readText(root, 'composer.json');
  if (composer) {
    try {
      const j = JSON.parse(composer) as Record<string, any>;
      const deps = { ...(j.require ?? {}), ...(j['require-dev'] ?? {}) };
      const type = deps['laravel/framework']
        ? 'Laravel (PHP) application'
        : deps['symfony/framework-bundle']
          ? 'Symfony (PHP) application'
          : 'PHP (Composer) project';
      return { name: j.name || fallbackName, type, stack: Object.keys(deps).slice(0, 8).join(', ') };
    } catch { /* malformed */ }
  }

  const pkg = await readText(root, 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as Record<string, any>;
      const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
      const has = (k: string): boolean => k in deps;
      let type = 'Node.js / JavaScript project';
      if (j.engines?.vscode || has('@types/vscode')) type = 'VS Code extension';
      else if (has('next')) type = 'Next.js (React) app';
      else if (has('@angular/core')) type = 'Angular app';
      else if (has('vue')) type = 'Vue app';
      else if (has('svelte')) type = 'Svelte app';
      else if (has('react')) type = 'React app';
      else if (has('@nestjs/core') || has('express') || has('fastify')) type = 'Node.js backend';
      else if (has('typescript')) type = 'TypeScript project';
      return { name: j.name || fallbackName, type, stack: Object.keys(deps).slice(0, 8).join(', ') };
    } catch { /* malformed */ }
  }

  const gomod = await readText(root, 'go.mod');
  if (gomod) {
    const m = /^module\s+(\S+)/m.exec(gomod);
    return { name: m?.[1] || fallbackName, type: 'Go module' };
  }

  const cargo = await readText(root, 'Cargo.toml');
  if (cargo) {
    const m = /name\s*=\s*"([^"]+)"/.exec(cargo);
    return { name: m?.[1] || fallbackName, type: 'Rust (Cargo) crate' };
  }

  const pyproject = await readText(root, 'pyproject.toml');
  if (pyproject) {
    const m = /name\s*=\s*"([^"]+)"/.exec(pyproject);
    return { name: m?.[1] || fallbackName, type: 'Python (pyproject) project' };
  }
  if (await readText(root, 'requirements.txt')) return { name: fallbackName, type: 'Python project' };

  if (await readText(root, 'pom.xml')) return { name: fallbackName, type: 'Java (Maven) project' };
  if ((await readText(root, 'build.gradle')) || (await readText(root, 'build.gradle.kts'))) {
    return { name: fallbackName, type: 'Gradle (JVM) project' };
  }

  return { name: fallbackName, type: 'project' };
}

/** First ~25 meaningful lines / 1500 chars of the README. */
function readmeExcerpt(text: string | undefined): string {
  if (!text) return '';
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() && out.length === 0) continue; // skip leading blanks
    out.push(line);
    if (out.length >= 25) break;
  }
  return out.join('\n').trim().slice(0, 1500);
}

/** A compact project summary for the system prompt, or '' if no workspace. */
export async function loadProjectGrounding(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return '';
  const root = folder.uri;
  const info = await detectProject(root, folder.name);

  const sections: string[] = [];
  const head = [`Name: ${info.name}`, `Type: ${info.type}`];
  if (info.stack) head.push(`Stack: ${info.stack}`);
  sections.push(head.join('\n'));

  const readme = readmeExcerpt(await readText(root, 'README.md'));
  if (readme) sections.push(`## README (excerpt)\n${readme}`);

  try {
    const map = await buildRepoMapSummary();
    const struct = [`Files: ${map.totalFiles}`];
    const dirs = map.directories.slice(0, 18).join(', ');
    const keys = map.keyFiles.slice(0, 12).join(', ');
    if (dirs) struct.push(`Top dirs: ${dirs}`);
    if (keys) struct.push(`Key files: ${keys}`);
    sections.push(`## Structure\n${struct.join('\n')}`);
  } catch { /* no workspace files to scan */ }

  return sections.join('\n\n').slice(0, MAX_CHARS);
}

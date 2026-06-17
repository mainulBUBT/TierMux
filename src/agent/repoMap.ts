// Cheap workspace overview, shared by the `repoMap` tool and project grounding.
import * as vscode from 'vscode';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.venv/**}';

export interface RepoMapSummary {
  totalFiles: number;
  rootFiles: string[];
  directories: string[];
  keyFiles: string[];
}

/** Scan the workspace once and summarize its shape (dirs, key files, counts). */
export async function buildRepoMapSummary(): Promise<RepoMapSummary> {
  const files = await vscode.workspace.findFiles('**/*', EXCLUDE, 3000);
  const rels = files.map((f) => vscode.workspace.asRelativePath(f)).sort();
  const dirCounts: Record<string, number> = {};
  const rootFiles: string[] = [];
  for (const r of rels) {
    const parts = r.split('/');
    if (parts.length === 1) { rootFiles.push(r); continue; }
    const key = parts.slice(0, Math.min(2, parts.length - 1)).join('/');
    dirCounts[key] = (dirCounts[key] ?? 0) + 1;
  }
  const directories = Object.entries(dirCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 120)
    .map(([d, c]) => `${d}/ (${c})`);
  const KEY = /(^|\/)(package\.json|composer\.json|tsconfig.*\.json|README(\.md)?|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle|Makefile|Dockerfile|\.env\.example)$/i;
  const keyFiles = rels.filter((r) => KEY.test(r)).slice(0, 40);
  return { totalFiles: rels.length, rootFiles: rootFiles.slice(0, 60), directories, keyFiles };
}

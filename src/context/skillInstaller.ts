

import { execFile } from 'child_process';

export interface InstallSkillResult {
  ok: boolean;
  output: string;
}

/** True if `npx` is on PATH — checked up front so a missing Node/npx install surfaces
 *  as a clear message instead of an opaque ENOENT after the user already waited. */
export function checkNpxAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('npx', ['--version'], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

/**
 * Runs `npx skills add <source> [--skill <skill>] -y` in the workspace root.
 * Requires Node/npx on PATH — callers should surface a clear error if it's missing
 * rather than let this fail with an opaque ENOENT.
 */
export function installSkillPackage(
  workspaceRoot: string,
  source: string,
  skill: string | undefined,
  onOutput: (chunk: string) => void,
): Promise<InstallSkillResult> {
  // The strings come from a remote catalog via the webview: only `owner/repo` (or its GitHub URL)
  // and a plain skill name reach the CLI, so a leading `-` cannot turn into a flag.
  if (!/^(https:\/\/github\.com\/)?[\w.-]+\/[\w.-]+(\.git)?$/.test(source) || (skill && !/^[\w.-]+$/.test(skill))) {
    return Promise.resolve({ ok: false, output: `Refused to install from "${source}"${skill ? ` (skill "${skill}")` : ''}: expected owner/repo.` });
  }
  const args = ['skills', 'add', source, ...(skill ? ['--skill', skill] : []), '-y'];
  return new Promise((resolve) => {
    const child = execFile('npx', args, { cwd: workspaceRoot, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      resolve({ ok: !err, output: output || (err ? String(err) : '') });
    });
    child.stdout?.on('data', (d) => onOutput(String(d)));
    child.stderr?.on('data', (d) => onOutput(String(d)));
  });
}

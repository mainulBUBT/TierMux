

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

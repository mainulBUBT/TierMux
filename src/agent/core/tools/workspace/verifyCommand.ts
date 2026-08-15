

// Verify-command resolution + execution for the end-of-turn command gate (loop.ts). The LSP
// diagnostics checks (formatDiagnostics.ts) prove the edited FILES parse; this proves the
// PROJECT still works — the auto-detected test/build command actually runs, and a non-zero
// exit feeds the failure output back for one self-correct retry. The fleet pipeline already
// gated worker merges this way (implementPipeline.ts verifyCommand); this is the same idea
// for the single-agent path, with the command auto-detected from the project manifest so the
// model can't skip verification by never passing one.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCommandGate } from '../gates';
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

/** package.json scripts, in verification preference order. `test` proves behavior; `typecheck`
 *  /`check`/`lint` at least prove it compiles; `build` is the weakest but still a real gate. */
function fromPackageScripts(pkg: Record<string, unknown>): string | undefined {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return undefined;
  const s = scripts as Record<string, string | undefined>;
  const npmRunner = typeof pkg.packageManager === 'string' && /pnpm/i.test(pkg.packageManager)
    ? 'pnpm'
    : typeof pkg.packageManager === 'string' && /yarn/i.test(pkg.packageManager) ? 'yarn' : 'npm';
  if (!isPlaceholderTestScript(s.test)) return `${npmRunner} test`;
  for (const k of ['typecheck', 'type-check', 'check', 'lint']) {
    if (s[k]) return `${npmRunner} run ${k}`;
  }
  if (s.build) return `${npmRunner} run build`;
  return undefined;
}

/** Best-effort, zero-LLM detection of "the one command that proves this project still works"
 *  from the workspace manifest. Returns undefined when nothing trustworthy exists — the caller
 *  then skips the command gate rather than running a guess. */
export function detectVerifyCommand(root: string): string | undefined {
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg) {
      const fromScripts = fromPackageScripts(pkg);
      if (fromScripts) return fromScripts;
    }
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(root, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
    return 'python -m pytest';
  }
  for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
    const p = path.join(root, mk);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, 'utf8');
    if (/^check:/m.test(body)) return 'make check';
    if (/^test:/m.test(body)) return 'make test';
  }
  const composer = readJson(path.join(root, 'composer.json'));
  if (composer?.scripts && typeof composer.scripts === 'object'
    && (composer.scripts as Record<string, unknown>).test) return 'composer test';
  return undefined;
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

/** Runs the verify command through the same CommandGate the agent's shell tool uses. Uses
 *  runApproved with no RunContext (same as the fleet pipeline's worker gate): a fresh one-shot
 *  spawn rather than the session's persistent shell, so the gate can't be poisoned by or poison
 *  any leftover shell state (cwd, env vars) from the agent's own commands. The gate fires only
 *  after the agent already mutated the workspace under the session's own approval policy, and
 *  the command comes from the user's own project manifest/settings — but the
 *  `commandApproval: 'never'` off-switch still applies inside runApproved as a hard safety net. */
export async function runVerifyCommand(command: string): Promise<VerifyRun> {
  try {
    const res = await getCommandGate().runApproved(command, undefined, undefined, 120_000);
    const output = ((res.error ? res.error + '\n' : '') + res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
    if (res.exitCode === null) return { ok: null, output };
    return { ok: res.exitCode === 0, output };
  } catch (e) {
    return { ok: null, output: e instanceof Error ? e.message : String(e) };
  }
}

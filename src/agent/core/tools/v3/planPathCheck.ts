// Mechanical grounding check for exitPlanMode: do the paths a plan names exist, and is the cited
// evidence line inside the file? Existence and line counts only — never a judgment of the plan.
// A plan that names files or lines that are not there was written from memory, not from a read.

import * as vscode from 'vscode';
import { resolveReadablePath } from '../resolvePath';

interface PlanStepLike { what: string; files?: string[]; evidence?: string }

const EVIDENCE_REF = /([A-Za-z0-9_@.\\/-]+\.[A-Za-z0-9]+):(\d+)/;

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

/** Returns a self-correcting error message, or undefined when every path and line checks out.
 *  A `files` entry may be a NEW file, so it only needs an existing parent directory. */
export async function checkPlanPaths(steps: PlanStepLike[]): Promise<string | undefined> {
  const problems: string[] = [];
  for (const s of steps) {
    for (const f of s.files ?? []) {
      let uri: vscode.Uri;
      try { uri = resolveReadablePath(f); } catch { return undefined; }
      if (await exists(uri)) continue;
      if (!(await exists(vscode.Uri.joinPath(uri, '..')))) problems.push(`step "${s.what}": "${f}" does not exist and neither does its folder`);
    }
    const ref = s.evidence ? EVIDENCE_REF.exec(s.evidence) : null;
    if (!ref) continue;
    let uri: vscode.Uri;
    try { uri = resolveReadablePath(ref[1]); } catch { return undefined; }
    const text = await readText(uri);
    if (text === undefined) { problems.push(`step "${s.what}": evidence cites ${ref[1]}, which does not exist`); continue; }
    const lines = text.split('\n').length;
    if (Number(ref[2]) > lines) problems.push(`step "${s.what}": evidence cites ${ref[1]}:${ref[2]}, but the file has only ${lines} lines`);
  }
  return problems.length
    ? `The plan names paths or lines that are not in the workspace — it was not grounded in files you read:\n- ${problems.join('\n- ')}\nRead the real files (grep/glob to find them), fix the paths and evidence, then call exitPlanMode again. A NEW file needs an existing parent folder.`
    : undefined;
}

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

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
const samePath = (a: string, b: string) => {
  const x = normPath(a);
  const y = normPath(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

function plainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n');
}

/** Evidence must come from something seen this turn, not from a file NAME: plan mode's prompt
 *  lists every file (context/fileMap.ts), so a `path:line` the model never opened would pass
 *  checkPlanPaths. Seen = a tool call that took the path as input (an aged read still counts), a
 *  tool result that names it (grep hits, a sub-agent's report), or a file the user attached (an
 *  @mention or the active editor block — a path merely named in the request does not count).
 *  No transcript, no check — the same rule as writeFile's visibleRead. */
export function unseenEvidence(steps: PlanStepLike[], messages?: ReadonlyArray<{ role: string; content: unknown }>): string | undefined {
  if (!messages?.length) return undefined;
  const inputs: string[] = [];
  const texts: string[] = [];
  const userTexts: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') { userTexts.push(plainText(m.content)); continue; }
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part.type === 'tool-call') {
        const input = (part.input ?? {}) as Record<string, unknown>;
        for (const v of [input.path, input.paths, input.file].flat()) if (typeof v === 'string') inputs.push(v);
      } else if (part.type === 'tool-result') {
        const value = (part.output as { value?: unknown } | undefined)?.value;
        texts.push(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
      }
    }
  }
  const unseen = steps.flatMap((s) => {
    const ref = s.evidence ? EVIDENCE_REF.exec(s.evidence) : null;
    if (!ref) return [];
    const rel = normPath(ref[1]);
    const attached = [`file \`${rel}\``, `file="${rel}"`, `<file path="${rel}"`];
    const seen = inputs.some((p) => samePath(p, rel)) || texts.some((t) => t.includes(rel))
      || userTexts.some((t) => attached.some((a) => t.includes(a)));
    return seen ? [] : [`step "${s.what}" cites ${ref[1]}:${ref[2]}`];
  });
  return unseen.length
    ? `Evidence must come from a file you opened or searched this turn, not from the file list:\n- ${unseen.join('\n- ')}\nRead those files (several paths in one readFile call), check the cited lines, then call exitPlanMode again.`
    : undefined;
}

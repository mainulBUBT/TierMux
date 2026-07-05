// Grounding verification: send a real codebase question through the live engine
// and assert the answer is grounded (cites files that exist) and within a tool-call
// budget (no overcall). Surfaced via the `tiermux.verifyGrounding` command.
//
// What it checks (the two failure modes the targeted-research policy is meant to fix):
//   1. HALLUCINATION — answer cites file paths. Do they actually exist on disk?
//      A hallucinated path (training-data memory) fails this.
//   2. OVERCALL — how many tool calls did the turn take? Ask mode should be ≤ BUDGET.
//      60 useless readFile calls (what the profiler once saw) fails this.
//
// It runs a single deterministic codebase question against the user's real engine
// (OC + router + their configured providers), so a pass means the grounding prompts
// actually produce grounded, bounded behavior on a real model — not just on paper.
import * as fs from 'fs';
import * as path from 'path';
import { runChatStream, type AgentOpts, type ToolEvent } from '../agent/sdk';
import type { Router } from '../router/router';

/** A codebase question whose answer MUST be read from the project (not memory). */
const TEST_QUESTION = 'What does this project do? List the main entry points and the primary source folders, with file paths.';

/** Ask mode should answer in a handful of targeted calls. */
const TOOL_BUDGET = 8;

export interface VerifyResult {
  ok: boolean;
  text: string;
  toolCalls: number;
  toolNames: string[];
  citedPaths: string[];
  missingPaths: string[];
  checks: { label: string; pass: boolean; detail: string }[];
}

/**
 * Run the grounding verification against the live engine.
 * @param router the extension's already-constructed Router (real providers/keys)
 * @param workspaceRoot the cwd OC already runs in — used to resolve cited paths
 */
export async function verifyGrounding(router: Router, workspaceRoot: string): Promise<VerifyResult> {
  const toolEvents: ToolEvent[] = [];
  const opts: AgentOpts = {
    messages: [{ role: 'user', content: TEST_QUESTION }],
    mode: 'chat',
    effort: 'medium',
    sessionId: `verify-${Date.now()}`,
    onChunk: () => {},
    onTool: (e) => { toolEvents.push(e); },
    onReasoning: () => {},
    onModel: () => {},
    onFailover: () => {},
    onStep: () => {},
    onTodos: () => {},
    onAskUser: async () => '',
    onError: () => {},
  };

  const result = await runChatStream(router, opts);
  const text = result.text || '';

  // Count DISTINCT tool calls (one toolCallId may emit queued/running/done).
  const distinctTools = new Map<string, ToolEvent>();
  for (const e of toolEvents) distinctTools.set(e.toolCallId, e);
  const toolNames = [...distinctTools.values()].map((e) => e.name);
  const toolCalls = distinctTools.size;

  // Extract candidate file paths from the answer and check existence.
  const citedPaths = extractPaths(text);
  const missingPaths: string[] = [];
  for (const p of citedPaths) {
    if (!pathExists(workspaceRoot, p)) missingPaths.push(p);
  }

  const checks: VerifyResult['checks'] = [];
  checks.push({ label: 'answer non-empty', pass: text.trim().length > 0, detail: `${text.length} chars` });
  checks.push({ label: 'cites at least one file path', pass: citedPaths.length > 0, detail: `${citedPaths.length} path(s)` });
  checks.push({ label: 'all cited paths exist on disk', pass: citedPaths.length > 0 && missingPaths.length === 0, detail: missingPaths.length ? `missing: ${missingPaths.slice(0, 3).join(', ')}` : 'all exist' });
  checks.push({ label: `tool calls within budget (≤${TOOL_BUDGET})`, pass: toolCalls <= TOOL_BUDGET, detail: `${toolCalls} calls: ${toolNames.join(', ') || 'none'}` });
  checks.push({ label: 'used a search tool (glob/grep/list) before read', pass: toolNames.some((n) => n === 'glob' || n === 'grep' || n === 'list'), detail: toolNames.join(', ') || 'no tools' });

  const ok = checks.every((c) => c.pass);
  return { ok, text, toolCalls, toolNames, citedPaths, missingPaths, checks };
}

/** Pull likely file/directory paths out of the answer text. */
function extractPaths(text: string): string[] {
  const out = new Set<string>();
  // [path:line] citations first (the format we asked for)
  const cite = /\[((?:\.\.?\/)?[\w./-]+(?:\.ts|\.js|\.tsx|\.jsx|\.json|\.md|\.py|\.go|\.rs|\.java)):\d+\]/g;
  let m: RegExpExecArray | null;
  while ((m = cite.exec(text)) !== null) out.add(m[1]);
  // bare paths: src/foo/bar.ts, media/main.js, etc. — at least one slash + an extension
  const bare = /(?:^|[\s(])(\.?\/?(?:[\w-]+\/)+[\w.-]+\.(?:ts|js|tsx|jsx|json|md|py|go|rs|java))/g;
  while ((m = bare.exec(text)) !== null) out.add(m[1].replace(/^[\s(]+/, ''));
  return [...out];
}

function pathExists(workspaceRoot: string, p: string): boolean {
  try {
    const abs = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

/** Render the result to an output channel. */
export function renderVerifyReport(r: VerifyResult): string {
  const lines: string[] = [];
  lines.push('TierMux grounding verification');
  lines.push('================================');
  lines.push(`Question: ${TEST_QUESTION}`);
  lines.push('');
  lines.push(`Result: ${r.ok ? '✅ PASS' : '❌ FAIL'}`);
  lines.push(`Tool calls: ${r.toolCalls}  (${r.toolNames.join(', ') || 'none'})`);
  lines.push(`Cited paths: ${r.citedPaths.length}  | missing: ${r.missingPaths.length}`);
  if (r.missingPaths.length) lines.push(`  MISSING (hallucinated?): ${r.missingPaths.join(', ')}`);
  lines.push('');
  lines.push('Checks:');
  for (const c of r.checks) lines.push(`  ${c.pass ? '✓' : '✗'} ${c.label} — ${c.detail}`);
  lines.push('');
  lines.push('Answer:');
  lines.push(r.text.slice(0, 2000));
  return lines.join('\n');
}

/** Re-export the test constant + budget so callers (or a future test) can reference them. */
export const VERIFY = { TEST_QUESTION, TOOL_BUDGET };

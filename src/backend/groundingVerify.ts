import * as fs from 'fs';
import * as path from 'path';
import { runPlanStream, type AgentOpts, type ToolEvent } from '../agent/sdk';
import type { Router } from '../router/router';

const TEST_QUESTIONS = [
  { q: 'List the files and folders directly inside your current working directory.', type: 'specific' as const },
  { q: 'How does authentication work in this project? Find the auth middleware and explain what it does.', type: 'broad' as const },
];

const TOOL_BUDGET = 8;

const GENERIC_PHRASES = [
  'typically', 'usually', 'in general', 'commonly', 'standard practice',
  'middleware is a function', 'authentication is the process', 'auth middleware intercepts',
  'a request comes in', 'the server checks', 'as an ai', 'i don\'t have access',
];

export interface SingleResult {
  question: string;
  type: 'specific' | 'broad';
  ok: boolean;
  text: string;
  toolCalls: number;
  toolNames: string[];
  citedPaths: string[];
  missingPaths: string[];
  checks: { label: string; pass: boolean; detail: string }[];
  debug: { platform?: string; model?: string; errors: string[]; reasoningLen: number; rawLen: number };
}

export interface VerifyResult {
  ok: boolean;
  passed: number;
  total: number;
  results: SingleResult[];
}

export async function verifyGrounding(router: Router, workspaceRoot: string): Promise<VerifyResult> {
  const results: SingleResult[] = [];

  for (const { q, type } of TEST_QUESTIONS) {
    results.push(await runOne(router, workspaceRoot, q, type));
  }

  const passed = results.filter((r) => r.ok).length;
  const ok = passed >= Math.ceil(results.length * 0.6);
  return { ok, passed, total: results.length, results };
}

async function runOne(
  router: Router,
  workspaceRoot: string,
  question: string,
  type: 'specific' | 'broad',
): Promise<SingleResult> {
  const toolEvents: ToolEvent[] = [];
  const errors: string[] = [];
  let reasoningText = '';

  const opts: AgentOpts = {
    messages: [{ role: 'user', content: question }],
    mode: 'plan',
    effort: 'medium',
    sessionId: `verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    onChunk: () => {},
    onTool: (e) => { toolEvents.push(e); },
    onReasoning: (t) => { reasoningText += t; },
    onModel: () => {},
    onFailover: () => {},
    onStep: () => {},
    onTodos: () => {},
    onAskUser: async () => '',
    onError: (e) => { errors.push(typeof e === 'string' ? e : (e as any)?.message ?? JSON.stringify(e)); },
  };

  const result = await runPlanStream(router, opts, {});
  const text = result.text || '';

  const distinctTools = new Map<string, ToolEvent>();
  for (const e of toolEvents) distinctTools.set(e.toolCallId, e);
  const toolNames = [...distinctTools.values()].map((e) => e.name);
  const toolCalls = distinctTools.size;

  const citedPaths = extractPaths(text);
  const missingPaths: string[] = [];
  for (const p of citedPaths) {
    if (!pathExists(workspaceRoot, p)) missingPaths.push(p);
  }

  const checks: SingleResult['checks'] = [];
  checks.push({ label: 'answer non-empty', pass: text.trim().length > 0, detail: `${text.length} chars` });
  checks.push({ label: 'tool calls within budget', pass: toolCalls <= TOOL_BUDGET, detail: `${toolCalls} calls` });
  checks.push({ label: 'no hallucinated paths', pass: missingPaths.length === 0, detail: missingPaths.length ? `missing: ${missingPaths.slice(0, 3).join(', ')}` : 'all exist' });
  checks.push({ label: 'cites file paths', pass: citedPaths.length > 0, detail: `${citedPaths.length} path(s)` });
  checks.push({ label: 'used search tool', pass: toolNames.some((n) => ['glob', 'grep', 'list'].includes(n)), detail: toolNames.join(', ') || 'none' });

  if (type === 'broad') {
    const lower = text.toLowerCase();
    const genericHits = GENERIC_PHRASES.filter((p) => lower.includes(p));
    checks.push({ label: 'not a generic answer', pass: genericHits.length === 0, detail: genericHits.length ? `generic phrases: ${genericHits.slice(0, 3).join(', ')}` : 'grounded' });
  }

  const ok = checks.filter((c) => c.pass).length >= Math.ceil(checks.length * 0.6);
  return {
    question, type, ok, text, toolCalls, toolNames, citedPaths, missingPaths, checks,
    debug: { platform: (result as any).platform, model: (result as any).model, errors, reasoningLen: reasoningText.length, rawLen: text.length },
  };
}

function extractPaths(text: string): string[] {
  const out = new Set<string>();
  const cite = /\[((?:\.\.?\/)?[\w./-]+(?:\.ts|\.js|\.tsx|\.jsx|\.json|\.md|\.py|\.go|\.rs|\.java)):\d+\]/g;
  let m: RegExpExecArray | null;
  while ((m = cite.exec(text)) !== null) out.add(m[1]);
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

export function renderVerifyReport(r: VerifyResult): string {
  const lines: string[] = [];
  lines.push('TierMux grounding verification');
  lines.push('================================');
  lines.push(`Overall: ${r.ok ? '✅ PASS' : '❌ FAIL'} (${r.passed}/${r.total} questions passed)`);
  lines.push('');

  for (const sr of r.results) {
    lines.push(`--- ${sr.type.toUpperCase()} ---`);
    lines.push(`Q: ${sr.question}`);
    lines.push(`Result: ${sr.ok ? '✅ PASS' : '❌ FAIL'}`);
    lines.push(`Tools: ${sr.toolCalls} (${sr.toolNames.join(', ') || 'none'})`);
    lines.push(`Paths: ${sr.citedPaths.length} cited, ${sr.missingPaths.length} missing`);
    for (const c of sr.checks) lines.push(`  ${c.pass ? '✓' : '✗'} ${c.label} — ${c.detail}`);
    lines.push(`Answer preview: ${sr.text.slice(0, 300) || '(empty)'}${sr.text.length > 300 ? '…' : ''}`);
    lines.push(`Debug: platform=${sr.debug.platform ?? '?'} model=${sr.debug.model ?? '?'} errors=${sr.debug.errors.length}`);
    for (const e of sr.debug.errors) lines.push(`  error: ${e}`);
    lines.push('');
  }

  return lines.join('\n');
}

export const VERIFY = { TEST_QUESTIONS, TOOL_BUDGET };

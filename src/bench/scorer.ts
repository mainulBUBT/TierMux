/**
 * Benchmark scoring.
 *
 * - Retrieval is scored programmatically from the files the agent opened: a query
 *   scores 1 if any opened basename contains one of its expected tokens.
 * - Reasoning (0/0.5/1) and Answer (0/1) are graded by the TierMux Router acting as
 *   an LLM judge, returning strict JSON.
 */
import type { ChatMessage } from '../shared/types';
import type { Router } from '../router/router';
import { contentToString } from '../agent/content';
import { type BenchQuery } from './queries';

export interface ToolTraceEntry {
  name: string;
  args: unknown;
}

/** Pull path/query-like strings out of a tool call's args object. */
export function pathsFromArgs(_name: string, args: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) out.push(v);
  };
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const key of ['path', 'file', 'file_path', 'filePath', 'query', 'q', 'pattern', 'include', 'glob']) push(a[key]);
  } else {
    push(args);
  }
  return out;
}

/** Basename (lowercased) of a path-like string; falls back to the raw lowercased string. */
function basenameOf(s: string): string {
  const t = s.trim().replace(/\\/g, '/');
  const last = t.split('/').pop() ?? t;
  return last.toLowerCase();
}

/** Score retrieval: 1 if any opened tool arg basename contains an expected token.
 *  Also reports whether the index/semantic pipeline was actually exercised (a
 *  separate signal — `retrieval=1, pipeline=0` means the agent brute-forced it with
 *  raw file reads, which works but doesn't validate the index stack). */
export function scoreRetrieval(trace: ToolTraceEntry[], expectedTokens: string[]): { score: 0 | 1; matched: string[]; pipelineUsed: boolean } {
  const opened = new Set<string>();
  // Only tools that actually inspect code count toward retrieval.
  const READING = new Set(['readFile', 'listDir', 'searchWorkspace', 'codebaseSearch', 'glob', 'grep', 'editFile', 'writeFile', 'createFile', 'getSymbolGraph', 'impactAnalysis']);
  // Index-stack entry points: `codebaseSearch` is the semantic tool; `searchWorkspace`
  // is the routed lookup that goes through the inverted/symbol index when available
  // (see agent.ts:488 — trackIndexHit() fires inside it). Raw `readFile`/`grep` do
  // NOT count — those bypass the index.
  const INDEX_TOOLS = new Set(['codebaseSearch', 'searchWorkspace']);
  let pipelineUsed = false;
  for (const e of trace) {
    if (INDEX_TOOLS.has(e.name)) pipelineUsed = true;
    if (!READING.has(e.name)) continue;
    for (const p of pathsFromArgs(e.name, e.args)) for (const b of p.split(/[,\s]+/)) {
      const bn = basenameOf(b);
      if (bn) opened.add(bn);
    }
  }
  const matched: string[] = [];
  for (const tok of expectedTokens) {
    const t = tok.toLowerCase();
    for (const b of opened) {
      if (b.includes(t)) { matched.push(tok); break; }
    }
  }
  // Hit if at least one expected token was matched. For queries with >1 expected
  // token, matching the primary (first) token is enough; matching any is a strong signal.
  return { score: matched.length > 0 ? 1 : 0, matched, pipelineUsed };
}

const SYSTEM = `You are a strict benchmark grader for an AI coding assistant operating on a Laravel codebase.
Grade the assistant's response on two axes and return ONLY a compact JSON object, no surrounding prose:

{"reasoning": <0 | 0.5 | 1>, "answer": <0 | 1>, "explanation": "<one short sentence justifying the scores>"}

Reasoning rubric:
  1   = correct, complete chain grounded in the actual code (right files/symbols, right mechanism)
  0.5 = correct direction but incomplete, vague, or a minor wrong detail
  0   = incorrect, hallucinated, or failed to engage the code

Answer rubric:
  1   = a competent bazardor developer would accept it (explain is accurate; fix/feature/refactor is the right approach + right place)
  0   = unacceptable (wrong, missing, or dangerously incorrect)

Be rigorous. Default downward when uncertain. Output JSON only.`;

export interface JudgeInput {
  query: BenchQuery;
  answer: string;
  reasoning?: string;
}

export interface JudgeVerdict {
  reasoning: number; // 0 | 0.5 | 1
  answer: number; // 0 | 1
  explanation?: string; // one-line audit trail from the judge
  raw?: string;
}

/** Ask the Router (as LLM judge) to grade reasoning + answer. */
export async function judgeAnswer(router: Router, judgeModel: string, input: JudgeInput): Promise<JudgeVerdict> {
  const user =
    `QUERY:\n${input.query.text}\n\n` +
    `EXPECTED RETRIEVAL (symbols/files):\n${input.query.expectedTokens.join(', ')}\n\n` +
    (input.reasoning ? `ASSISTANT REASONING:\n${input.reasoning.slice(0, 2000)}\n\n` : '') +
    `ASSISTANT ANSWER:\n${(input.answer || '(no answer produced)').slice(0, 4000)}\n\n` +
    `Return the JSON verdict now.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
  let raw = '';
  try {
    const res = await router.route(messages, { model: judgeModel, temperature: 0 });
    raw = contentToString(res.response.choices[0]?.message?.content);
  } catch {
    return { reasoning: 0, answer: 0, raw: '(judge call failed)' };
  }
  return parseVerdict(raw);
}

/** Parse {"reasoning":..,"answer":..,"explanation":..} out of a model reply, tolerating surrounding text. */
export function parseVerdict(raw: string): JudgeVerdict {
  const verdict: JudgeVerdict = { reasoning: 0, answer: 0, raw };
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return verdict;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const r = Number(obj.reasoning);
    const a = Number(obj.answer);
    verdict.reasoning = r === 0.5 ? 0.5 : r >= 1 ? 1 : 0;
    verdict.answer = a >= 1 ? 1 : 0;
    if (typeof obj.explanation === 'string' && obj.explanation.trim()) verdict.explanation = obj.explanation.trim();
  } catch { /* leave zeros */ }
  return verdict;
}

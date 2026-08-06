// Verifies the quality benchmark's SCORING rules against fixture traces — the part that must be
// deterministic. A live bench run cannot serve as this check: it depends on a free model that
// picks different tools every time, so a green live run proves nothing about the scorer and a red
// one doesn't localize the fault.
//
// The rules under test are the ones that decide whether a number means anything:
//  1. Opening the expected file scores retrieval 1; not reaching it scores 0 and names the miss.
//  2. A file that merely appeared in a grep dump does NOT count — otherwise one unscoped grep
//     over the repo would hand every query a free 1.0.
//  3. …unless the answer goes on to cite it, which is what separates "grepped and used it" from
//     "grepped and ignored it".
//  4. Grep fallback only counts an UNSCOPED first grep; a scoped one is targeted search.
//  5. Window-read rate ignores errored reads and never passes on zero reads.
//
// Run: npm run test:e2e:bench-score
import { efficiency, scoreRetrieval, summarizeQuality, usedGrepFallback } from './bench/qualityScore';
import type { QualityQuery, QualityResult, TraceEntry } from './bench/qualityTypes';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const QUERY: QualityQuery = {
  id: 'T1',
  category: 'explain',
  query: 'how does capping work?',
  mode: 'ask',
  expectFiles: ['src/agent/core/tools/capOutput.ts'],
};

function trace(name: string, over: Partial<TraceEntry> = {}): TraceEntry {
  return { name, paths: [], outputChars: 0, ...over };
}

function result(over: Partial<QualityResult>): QualityResult {
  return {
    queryId: 'T', category: 'explain', query: 'q', mode: 'ask', ok: true,
    answer: '', selectedModel: 'x::y', latencyMs: 1, trace: [],
    openedFiles: [], seenFiles: [], missedFiles: [],
    scores: { retrieval: 0, reasoning: 0, answer: 0, judged: true },
    errorMessage: null,
    ...over,
  };
}

// --- 1. opened file scores 1; a miss scores 0 and is named ---
{
  const hit = scoreRetrieval(QUERY, { openedFiles: ['src/agent/core/tools/capOutput.ts'], seenFiles: [], answer: 'it caps output' });
  ok('opened the expected file → retrieval 1', hit.score === 1 && hit.missed.length === 0);

  const miss = scoreRetrieval(QUERY, { openedFiles: ['src/router/router.ts'], seenFiles: [], answer: 'something' });
  ok('never opened it → retrieval 0, miss reported', miss.score === 0 && miss.missed[0] === 'src/agent/core/tools/capOutput.ts');
}

// --- 2/3. grep-dump paths are not retrieval unless the answer cites them ---
{
  const dump = Array.from({ length: 150 }, (_, i) => `src/generated/file${i}.ts`).concat('src/agent/core/tools/capOutput.ts');
  const ignored = scoreRetrieval(QUERY, { openedFiles: [], seenFiles: dump, answer: 'Output is capped somewhere in the agent core.' });
  ok('file only listed in a grep dump, never cited → retrieval 0', ignored.score === 0);

  const cited = scoreRetrieval(QUERY, { openedFiles: [], seenFiles: dump, answer: 'See src/agent/core/tools/capOutput.ts — capToolOutput trims the result.' });
  ok('grep-listed AND cited in the answer → retrieval 1', cited.score === 1);
}

// --- expectAnyOf: one hit is enough, zero hits is a miss ---
{
  const q: QualityQuery = { ...QUERY, expectAnyOf: ['src/agent/core/loop.ts', 'src/agent/agent.ts'] };
  const one = scoreRetrieval(q, { openedFiles: ['src/agent/core/tools/capOutput.ts', 'src/agent/agent.ts'], seenFiles: [], answer: '' });
  ok('expectAnyOf satisfied by one alternate → retrieval 1', one.score === 1);

  const none = scoreRetrieval(q, { openedFiles: ['src/agent/core/tools/capOutput.ts'], seenFiles: [], answer: '' });
  ok('expectAnyOf satisfied by none → retrieval 0', none.score === 0 && none.missed.some((m) => m.startsWith('(any of')));
}

// --- suffix matching, not substring: a same-named file elsewhere must not satisfy it ---
{
  const wrong = scoreRetrieval(QUERY, { openedFiles: ['vendor/other/capOutput.ts'], seenFiles: [], answer: '' });
  ok('same basename in a different directory → retrieval 0', wrong.score === 0);
}

// --- 4. grep fallback: unscoped first grep only ---
{
  ok('unscoped first grep → fallback', usedGrepFallback([trace('grep'), trace('readFile', { paths: ['a.ts'] })]));
  ok('scoped first grep → not a fallback', !usedGrepFallback([trace('grep', { paths: ['src/router'] })]));
  ok('glob first, then grep → not a fallback', !usedGrepFallback([trace('glob', { paths: ['src/**/*.ts'] }), trace('grep')]));
  ok('no retrieval tools at all → not a fallback', !usedGrepFallback([trace('todowrite')]));
}

// --- 5. window reads: errored reads excluded, zero reads never passes ---
{
  const e = efficiency([
    result({ trace: [
      trace('readFile', { paths: ['a.ts'], windowed: true }),
      trace('readFile', { paths: ['b.ts'], windowed: false }),
      trace('readFile', { paths: ['c.ts'], windowed: false, error: 'AI_NoSuchToolError' }),
    ] }),
  ]);
  ok('window rate over successful reads only (1 of 2)', e.readCount === 2 && Math.abs(e.windowReadRate - 0.5) < 1e-9);
  ok('tool error rate counts the failed call (1 of 3)', Math.abs(e.toolErrorRate - 1 / 3) < 1e-9);

  const noReads = summarizeQuality([result({ trace: [trace('grep', { paths: ['src'] })] })]);
  ok('zero successful reads → window-read gate does NOT pass', noReads.pass.windowRead === false);
}

// --- summary aggregation + the diagnosis table ---
{
  const rows: QualityResult[] = [
    result({ queryId: 'A', scores: { retrieval: 1, reasoning: 1, answer: 1, judged: true } }),
    result({ queryId: 'B', scores: { retrieval: 1, reasoning: 0.5, answer: 1, judged: true } }),
    result({ queryId: 'C', category: 'bugfix', scores: { retrieval: 0, reasoning: 0, answer: 0, judged: true } }),
  ];
  const s = summarizeQuality(rows);
  ok('retrieval % = 2/3', Math.abs(s.retrievalPct - 66.666) < 0.01);
  ok('reasoning % counts 0.5 as half', Math.abs(s.reasoningPct - 50) < 0.01);
  ok('per-category split is kept', s.byCategory.length === 2 && s.byCategory.find((c) => c.category === 'bugfix')?.retrievalPct === 0);
  ok('below target → not passed', s.pass.overall === false);

  const allGood = summarizeQuality(Array.from({ length: 10 }, (_, i) =>
    result({ queryId: `G${i}`, scores: { retrieval: 1, reasoning: 1, answer: 1, judged: true } })));
  ok('all three at 100% → MVP PASSED', allGood.pass.overall === true && allGood.diagnosis.startsWith('MVP PASSED'));

  const weakModel = summarizeQuality(Array.from({ length: 10 }, (_, i) =>
    result({ queryId: `W${i}`, scores: { retrieval: 1, reasoning: i < 5 ? 1 : 0, answer: 1, judged: true } })));
  ok('high retrieval + low reasoning → diagnosed as a model/prompt bottleneck',
    weakModel.diagnosis.includes('model/prompt bottleneck'));

  const badRetrieval = summarizeQuality(Array.from({ length: 10 }, (_, i) =>
    result({ queryId: `R${i}`, scores: { retrieval: i < 5 ? 1 : 0, reasoning: 1, answer: 1, judged: true } })));
  ok('low retrieval + high reasoning → diagnosed as a retrieval-pipeline problem',
    badRetrieval.diagnosis.includes('Retrieval is the bottleneck'));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

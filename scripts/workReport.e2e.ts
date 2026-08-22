/**
 * workReport e2e — the structured end-of-turn report (WorkReportData) and its legacy
 * markdown serialization. Covers:
 *   1. renderLegacyMarkdown output for every verifyOutcome, including the load-bearing
 *      marker phrases e2e suites key on ('Verification failed', 'Unverified').
 *   2. Emit/strip round-trip: stripLegacyMarkdown(text + render(report), report) === text,
 *      and render(strip(text, report)) === render — live==replay through one implementation.
 *   3. WorkReportData shape invariants (version, telemetry nesting, status letters).
 *
 * Run: npm run test:e2e:workReport
 */

import {
  renderLegacyMarkdown,
  stripLegacyMarkdown,
  type WorkReportData,
} from '../src/shared/workReport';

let pass = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseReport(over: Partial<WorkReportData>): WorkReportData {
  return {
    version: 1,
    verifyOutcome: 'unverified',
    fixRounds: 0,
    changedFiles: [],
    toolTally: [],
    stopReason: '',
    telemetry: {
      model: 'openrouter/deepseek/deepseek-chat-v3.1',
      taskKind: 'coding',
      inputTokens: 1234,
      outputTokens: 567,
      toolCalls: 7,
      thoughts: 2,
      failovers: 1,
      elapsedMs: 42_500,
    },
    ...over,
  } as WorkReportData;
}

console.log('workReport.e2e');

// ── Outcome rendering ───────────────────────────────────────────────────────────────────
{
  const md = renderLegacyMarkdown(baseReport({
    verifyOutcome: 'verified', verifyCmd: 'npm run build', fixRounds: 1,
  }));
  assert(md.includes('**✅ Verified** — `npm run build` passed (after 1 fix round).'), 'verified line with fix round');
}
{
  const md = renderLegacyMarkdown(baseReport({ verifyOutcome: 'failed', verifyCmd: 'npm test', fixRounds: 2 }));
  assert(md.includes('**❌ Verification failed**'), 'load-bearing marker: Verification failed');
  assert(md.includes('`npm test` still fails after 2 fix rounds.'), 'failed line names cmd + rounds');
}
{
  const md = renderLegacyMarkdown(baseReport({ verifyOutcome: 'unverified' }));
  assert(md.includes('**⚠️ Unverified**'), 'load-bearing marker: Unverified');
  assert(md.includes('no test command'), 'untested reason present');
}
{
  const md = renderLegacyMarkdown(baseReport({ verifyOutcome: 'unverified', stopReason: 'budget' }));
  assert(md.includes('run ended before the final check'), 'stopReason switches the untested reason');
}
{
  const md = renderLegacyMarkdown(baseReport({ verifyOutcome: 'changes-only' }));
  assert(md.includes('**✅ Changes applied**'), 'changes-only outcome renders');
}

// ── Files grouping (A/M/D → created/modified/deleted wording) ────────────────────────────
{
  const md = renderLegacyMarkdown(baseReport({
    changedFiles: [
      { path: 'new.ts', status: 'A' },
      { path: 'edit.ts', status: 'M' },
      { path: 'old.ts', status: 'D' },
    ],
  }));
  assert(
    md.includes('created: new.ts') && md.includes('modified: edit.ts') && md.includes('deleted: old.ts'),
    'file statuses group by created/modified/deleted',
  );
}

// ── Tool tally: top-6 + overflow ────────────────────────────────────────────────────────
{
  const tally = ['readFile', 'grep', 'writeFile', 'listDir', 'glob', 'bash', 'todoWrite']
    .map((name, i) => ({ name, count: 10 - i }));
  const md = renderLegacyMarkdown(baseReport({ toolTally: tally }));
  assert(md.includes('**Tools used:** 49 calls'), `total calls counted (got: ${md.match(/\*\*Tools used:\*\* [0-9]+ [a-z]+/)?.[0]})`);
  assert(md.includes('+1 more'), 'overflow beyond top-6 noted');
}

// ── Round-trip: emit → append to prose → strip is lossless; re-render is stable ──────────
for (const outcome of ['verified', 'failed', 'unverified', 'changes-only'] as const) {
  const report = baseReport({
    verifyOutcome: outcome,
    verifyCmd: outcome === 'unverified' ? undefined : 'make check',
    changedFiles: [{ path: 'x.ts', status: 'M' }],
    toolTally: [{ name: 'readFile', count: 3 }],
  });
  const prose = 'Done — rewrote the handler.';
  const withMd = prose + renderLegacyMarkdown(report);
  const stripped = stripLegacyMarkdown(withMd, report);
  assert(stripped === prose, `${outcome}: strip removes exactly the emitted block`);
  assert(renderLegacyMarkdown(report) === withMd.slice(prose.length), `${outcome}: re-render is byte-stable`);
  // Legacy transcript WITHOUT a block (old prose only) passes through unchanged.
  assert(stripLegacyMarkdown(prose, report) === prose, `${outcome}: stripping absent block is a no-op`);
}

// ── Shape invariants ────────────────────────────────────────────────────────────────────
{
  const r = baseReport({});
  assert(r.version === 1, 'report is versioned');
  assert(typeof r.telemetry.model === 'string' && r.telemetry.model.includes('/'), 'telemetry.model is "provider/modelId"');
  assert(!('inputTokens' in r), 'no duplicated token fields at the top level (nested under telemetry)');
}

console.log(`\n${pass} passed, ${failed} failed`);
if (failed) process.exit(1);

// Tool-result compaction: runCommand head+tail at every level, search tools line-capped at
// 'aggressive' only, readFile/edit results NEVER touched, short outputs and 'off' pass
// through verbatim. Also exercises the config reader default ('light' via vscodeMock).
//
// Run:  npm run test:e2e:compact-result
import { compactToolResult, toolCompactionLevel } from '../src/agent/core/tools/compactResult';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const big = (n: number, tag: string): string => Array.from({ length: Math.ceil(n / 80) }, (_, i) => `${tag} line ${i} ${'x'.repeat(70)}`).join('\n');

async function main() {
  ok('config default reads as light (vscodeMock default path)', toolCompactionLevel() === 'light');

  // ---- runCommand: compacted at BOTH levels ----
  for (const level of ['light', 'aggressive'] as const) {
    const out = compactToolResult('runCommand', big(30_000, 'cmd'), level);
    ok(`runCommand compacted at ${level}: shrunk hard`, out.length < 3_000 && out.length > 500);
    ok(`runCommand compacted at ${level}: head+tail marker present`, out.includes('[TierMux: compacted runCommand output'));
    ok(`runCommand compacted at ${level}: keeps the tail (final status)`, out.includes('cmd line'));
  }

  // ---- readFile: NEVER compacted ----
  const read = compactToolResult('readFile', big(30_000, 'src'), 'aggressive');
  ok('readFile never compacted (verbatim, even aggressive)', read === big(30_000, 'src'));

  // ---- editFile / diagnostics: never compacted ----
  ok('editFile never compacted', compactToolResult('editFile', big(30_000, 'e'), 'aggressive').length > 29_000);
  ok('getDiagnostics never compacted', compactToolResult('getDiagnostics', big(30_000, 'd'), 'aggressive').length > 29_000);

  // ---- grep: untouched at light, line-capped at aggressive ----
  const grepBig = big(20_000, 'match');
  ok('grep untouched at light', compactToolResult('grep', grepBig, 'light') === grepBig);
  const grepOut = compactToolResult('grep', grepBig, 'aggressive');
  ok(`grep line-capped at aggressive (${grepOut.length} chars)`, grepOut.length < grepBig.length && grepOut.includes('[TierMux: compacted grep output'));

  // ---- short outputs + off: verbatim ----
  ok('short output untouched', compactToolResult('runCommand', 'exit 0\nok', 'aggressive') === 'exit 0\nok');
  ok('off: verbatim', compactToolResult('runCommand', big(30_000, 'cmd'), 'off') === big(30_000, 'cmd'));
  ok('unknown tool verbatim', compactToolResult('mcp__server__tool', big(30_000, 'm'), 'aggressive') === big(30_000, 'm'));

  // ---- config override respected ----
  (globalThis as { __tiermuxTestConfig?: Record<string, unknown> }).__tiermuxTestConfig = { toolCompaction: 'off' };
  ok("config override 'off' respected", toolCompactionLevel() === 'off');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

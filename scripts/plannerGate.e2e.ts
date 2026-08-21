// Planner gate: the pure heuristic deciding which action requests skip the planner's extra
// serial LLM round-trip. Confident/short/single-action → skip; anything multi-step-shaped
// (lists, joiners, several files, long, ambiguous) → plan.
//
// Run:  npm run test:e2e:planner-gate
import { plannerUnnecessary } from '../src/agent/core/loop';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function main() {
  // ---- skip: confident, short, single action ----
  ok('fix typo request skips planner', plannerUnnecessary('fix the typo in utils.ts') === true);
  ok('add import request skips planner', plannerUnnecessary('add the missing import to main.ts') === true);
  ok('rename request skips planner', plannerUnnecessary('rename getUser to fetchUser in api.ts') === true);
  ok('remove console.log skips planner', plannerUnnecessary('remove the console.log in server.js') === true);

  // ---- plan: multi-step shapes ----
  ok('joiner word plans', plannerUnnecessary('fix the bug in utils.ts then update the tests') === false);
  ok('numbered list plans', plannerUnnecessary('do this:\n1. fix a.ts\n2. fix b.ts') === false);
  ok('two file references plan', plannerUnnecessary('update config.json and package.json versions') === false);
  ok('long request plans (>220 chars)', plannerUnnecessary(`refactor the authentication module ${'blah '.repeat(60)}`) === false);
  ok('ambiguous (low-confidence) request plans', plannerUnnecessary('hmm maybe the thing') === false);
  ok('empty text plans (safe default)', plannerUnnecessary('') === false);

  // ---- read-only kinds never reach the gate (mixtureEligible filters them), but the
  //      heuristic itself must not green-light questions either ----
  ok('question is not gate-positive', plannerUnnecessary('what does this file do?') === false);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

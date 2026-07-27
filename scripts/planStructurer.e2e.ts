// Regression test for the Plan-mode structured-output wiring:
//   1. structurePlanSteps() (src/agent/planStructurer.ts) actually parses a fake model's
//      structured JSON output into a clean string[], and falls back to null on bad/empty input.
//   2. formatStructuredSteps() re-serializes that list into the exact numbered-list text format
//      the webview's Plan.ts (parsePlanSteps) and session/titles.ts (planStepsToTodos) already
//      parse — this is what lets chatViewProvider.ts's structurePlanText() drop the model's clean
//      steps straight into the existing `planProposed.steps` field with no webview changes.
//
// Drives the REAL structurePlanSteps() -> createRouterProvider() -> generateText() pipeline with
// a fake Router — only the model layer is faked, everything above it (including the AI SDK's own
// structured-output JSON parsing/validation) is real.
//
// Run: npm run test:e2e:plan-structurer
import { structurePlanSteps, formatStructuredSteps } from '../src/agent/planStructurer';
import type { Router } from '../src/router/router';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function baseResponse(content: string) {
  return {
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content } }],
  };
}

function fakeRouter(content: string): Router {
  return {
    async route() {
      return { platform: 'custom' as const, model: 'fake', response: baseResponse(content) };
    },
  } as unknown as Router;
}

async function main() {
  // --- structurePlanSteps: clean structured JSON -> matching string[] ---
  {
    const router = fakeRouter(JSON.stringify({ steps: ['Read routing.ts to find classifyTask', 'Add a plan branch before the classifier call'] }));
    const steps = await structurePlanSteps(router, 'Some confirmed plan prose with steps.');
    ok('parses a clean structured-output response into a string[]', Array.isArray(steps) && steps?.length === 2);
    ok('preserves step text verbatim (trimmed)', steps?.[0] === 'Read routing.ts to find classifyTask');
  }

  // --- structurePlanSteps: malformed JSON -> null (caller falls back to the regex parser) ---
  {
    const router = fakeRouter('This is not JSON at all.');
    const steps = await structurePlanSteps(router, 'Some confirmed plan prose.');
    ok('malformed model output falls back to null, not a throw', steps === null);
  }

  // --- structurePlanSteps: empty steps array -> null, not an empty array ---
  {
    const router = fakeRouter(JSON.stringify({ steps: [] }));
    const steps = await structurePlanSteps(router, 'Some confirmed plan prose.');
    ok('empty steps array normalizes to null', steps === null);
  }

  // --- structurePlanSteps: empty input text -> null without calling the router ---
  {
    let called = false;
    const router = { async route() { called = true; return { platform: 'custom' as const, model: 'fake', response: baseResponse('{}') }; } } as unknown as Router;
    const steps = await structurePlanSteps(router, '   ');
    ok('blank plan text short-circuits to null', steps === null);
    ok('blank plan text never calls the router', !called);
  }

  // --- formatStructuredSteps: re-serialization matches Plan.ts/titles.ts's expected format ---
  {
    const text = formatStructuredSteps(['Read foo.ts', 'Edit bar.ts', 'Run the tests']);
    ok('formats as a 1-indexed numbered list', text === '1. Read foo.ts\n2. Edit bar.ts\n3. Run the tests');
    // Mirrors Plan.ts's own parsePlanSteps regex — confirms the round trip actually works.
    const parsed = text.split('\n').map((l) => l.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/)?.[1]).filter(Boolean);
    ok('round-trips through the webview\'s own numbered-list parser unchanged', JSON.stringify(parsed) === JSON.stringify(['Read foo.ts', 'Edit bar.ts', 'Run the tests']));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });

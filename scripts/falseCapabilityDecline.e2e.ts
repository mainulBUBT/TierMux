// Regression test for `detectFalseCapabilityDecline` — the regex-first, LLM-classify-fallback
// detector for a model in Agent mode flatly claiming it has no execution/runtime/test-running
// capability (e.g. "I cannot run tests... there's no access to the test suite, database, or
// runtime") despite Agent mode having a real `runCommand` tool. Mirrors classifyTaskSmart's
// (routing.ts/loop.ts) and tryModelRepair's (repairToolCall Tier 3) regex-first/LLM-fallback
// shape: a confident regex match never needs the LLM; a decline-shaped-but-unmatched paraphrase
// escalates to one cheap classify call; a non-decline reply never triggers the call at all.
//
// Tested DIRECTLY (like tryModelRepair in repairToolCallTier3.e2e.ts) rather than through the
// full runTurn() pipeline — this session found that pipeline unreliable for triggering
// classify-style calls through a fake-Router harness.
//
// Run: npm run test:e2e:false-capability-decline
import { detectFalseCapabilityDecline } from '../src/agent/core/loop';
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

function throwingRouter(): Router {
  return {
    async route() { throw new Error('route() should NEVER be called for this case'); },
    async pickUtilityModel() { throw new Error('pickUtilityModel() should NEVER be called for this case'); },
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
  } as unknown as Router;
}

function classifyingRouter(reply: 'false_decline' | 'other'): Router {
  return {
    // The AI SDK's `output: 'enum'` internally wraps the schema as `{ result: <enum> }` — the
    // fake provider must return JSON matching that shape, not the bare enum string.
    async route() { return { platform: 'custom' as const, model: 'utility', response: baseResponse(JSON.stringify({ result: reply })) }; },
    async pickUtilityModel() { return 'utility-fake'; },
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'utility-fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
  } as unknown as Router;
}

function throwingClassifyRouter(): Router {
  return {
    async route() { throw new Error('classify model unavailable'); },
    async pickUtilityModel() { return 'utility-fake'; },
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'utility-fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
  } as unknown as Router;
}

async function main() {
  // --- Test 1: the exact reported phrase matches the regex fast-path — never touches the router. ---
  {
    const text = "I cannot run tests in this environment — there's no access to the test suite, database, or runtime. You'll need to run the tests yourself.";
    const result = await detectFalseCapabilityDecline(throwingRouter(), text);
    ok('reported phrase: regex fast-path returns true', result === true);
  }

  // --- Test 2: a two-sentence variant (decline split across sentence boundaries) still matches
  // the fast-path — the [\s\S]{0,100} gap deliberately spans sentences. ---
  {
    const text = 'I cannot run this request. I have no access to the test suite.';
    const result = await detectFalseCapabilityDecline(throwingRouter(), text);
    ok('two-sentence decline: regex fast-path spans the sentence boundary', result === true);
  }

  // --- Test 3: a neutral, non-decline reply never calls the router at all (pre-filter skips it). ---
  {
    const text = "Here's the answer: 42. The affiliate tracking works for both guest and registered orders.";
    const result = await detectFalseCapabilityDecline(throwingRouter(), text);
    ok('neutral reply: pre-filter skips the call entirely, returns false', result === false);
  }

  // --- Test 4: decline-shaped language the regex does NOT catch — e.g. "unable to" without the
  // execution/runtime-specific vocabulary the regex requires — escalates to the LLM classifier,
  // which recognizes it as a false decline. ---
  {
    const text = "I'm unable to help with that particular part of the request.";
    const result = await detectFalseCapabilityDecline(classifyingRouter('false_decline'), text);
    ok('decline-shaped, regex misses, classifier says false_decline: returns true', result === true);
  }

  // --- Test 5: same decline-shaped input, but the classifier judges it a genuine (non-capability)
  // decline — e.g. missing information — must NOT trigger a retry. ---
  {
    const text = "I'm unable to help with that particular part of the request.";
    const result = await detectFalseCapabilityDecline(classifyingRouter('other'), text);
    ok('decline-shaped, classifier says other: returns false (no false-positive retry)', result === false);
  }

  // --- Test 6: the classify call itself fails (model unavailable/timeout) — must degrade to
  // false, never throw. ---
  {
    const text = "I'm unable to help with that particular part of the request.";
    let threw = false;
    let result: boolean | undefined;
    try { result = await detectFalseCapabilityDecline(throwingClassifyRouter(), text); }
    catch { threw = true; }
    ok('classify call throws: caught internally, does not propagate', !threw);
    ok('classify call throws: degrades to false', result === false);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error('FATAL', err); process.exitCode = 1; });

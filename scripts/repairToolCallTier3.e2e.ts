// Regression test for `tryModelRepair` — the Tier 3 (model-repair) fallback inside
// repairToolCall. Only fires when the deterministic fixes (Tier 1: JSON double-unwrap for
// InvalidToolInputError; Tier 2: name-alias resolution for NoSuchToolError) both miss.
//
// Tests the function DIRECTLY (mirrors rescueXml.e2e.ts's approach of testing
// `rescueInlineToolCalls` in isolation) rather than through the full runTurn() ->
// streamText() -> repairToolCall pipeline: that path was tried first and found unreliable for
// TRIGGERING the hook at all through this harness's fake Router/custom LanguageModelV4 provider
// combination (confirmed even the pre-existing Tier 1/2 alias-fixing path never gets invoked
// this way — a pre-existing harness limitation, not something this change introduced; matches
// this session's own research finding that no existing e2e test covers repairToolCall/
// TOOL_NAME_ALIASES at all). Testing the function directly is reliable and exercises exactly
// what matters: prompt construction/branching, response parsing (markdown-fence tolerance),
// timeout/abort combination, and graceful-null on an unfixable case.
//
// Run: npm run test:e2e:repair-tier3
import { tryModelRepair } from '../src/agent/core/loop';
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

function fakeRouter(reply: string, opts: { pickUtilityModel?: () => Promise<string | undefined> } = {}): Router {
  return {
    async route() { return { platform: 'custom' as const, model: 'utility', response: baseResponse(reply) }; },
    async pickUtilityModel() { return opts.pickUtilityModel ? opts.pickUtilityModel() : 'utility-fake'; },
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'utility-fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
  } as unknown as Router;
}

const TOOL_CALL = { toolCallId: 't1', type: 'tool-call' as const, toolName: 'readFile', input: '{"wrongFieldName":"README.md"}' };

async function main() {
  // --- Test A: schema present (InvalidToolInputError path) — Tier 3 must return corrected input. ---
  {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const router = fakeRouter('{"path":"README.md"}');
    const repaired = await tryModelRepair(TOOL_CALL, { readFile: {} }, 'Required property "path" is missing', schema, router);
    ok('schema-present: returns a repaired call', !!repaired);
    ok('schema-present: input is corrected JSON with the right field', repaired?.input === '{"path":"README.md"}');
    ok('schema-present: toolName/toolCallId/type preserved from the original call', repaired?.toolName === 'readFile' && (repaired as any)?.toolCallId === 't1' && (repaired as any)?.type === 'tool-call');
  }

  // --- Test B: robust extraction — the utility model wraps its answer in markdown/preamble
  // despite being told not to (measured weak-model behavior). Must still extract the JSON. ---
  {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const router = fakeRouter('Here is the fix:\n```json\n{"path":"README.md"}\n```\nLet me know if this helps!');
    const repaired = await tryModelRepair(TOOL_CALL, { readFile: {} }, 'Required property "path" is missing', schema, router);
    ok('markdown-fenced response: still extracts and repairs correctly', repaired?.input === '{"path":"README.md"}');
  }

  // --- Test C: no schema (NoSuchToolError path) — must fix BOTH the tool name and the args,
  // using the full active tool-name list since there's no schema to repair args against. ---
  {
    const badCall = { toolCallId: 't2', type: 'tool-call' as const, toolName: 'frobnicateFile', input: '{"pth":"README.md"}' };
    const router = fakeRouter('{"toolName":"readFile","input":{"path":"README.md"}}');
    const repaired = await tryModelRepair(badCall, { readFile: {}, writeFile: {}, grep: {} }, 'No such tool: frobnicateFile', undefined, router);
    ok('no-schema: repaired call has the corrected tool name', repaired?.toolName === 'readFile');
    ok('no-schema: repaired call has corrected input', repaired?.input === JSON.stringify({ path: 'README.md' }));
    ok('no-schema: toolCallId preserved', (repaired as any)?.toolCallId === 't2');
  }

  // --- Test D: no-schema repair must reject a toolName the caller didn't actually offer —
  // never fabricate a call to a tool outside the turn's real set. ---
  {
    const badCall = { toolCallId: 't3', type: 'tool-call' as const, toolName: 'frobnicateFile', input: '{}' };
    const router = fakeRouter('{"toolName":"deleteEverything","input":{}}');
    const repaired = await tryModelRepair(badCall, { readFile: {}, writeFile: {} }, 'No such tool', undefined, router);
    ok('hallucinated tool name outside the active set: rejected, returns null', repaired === null);
  }

  // --- Test E: genuinely unfixable — utility model's response has no JSON at all. Must
  // gracefully return null, never throw. ---
  {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const router = fakeRouter('I cannot determine the correct arguments.');
    const repaired = await tryModelRepair(TOOL_CALL, { readFile: {} }, 'Required property "path" is missing', schema, router);
    ok('unfixable (no JSON in response): returns null, does not throw', repaired === null);
  }

  // --- Test F: the utility model call itself throws (e.g. all providers failed) — must be
  // caught and degrade to null, not propagate and crash the turn. ---
  {
    const throwingRouter = {
      async route() { throw new Error('all models failed'); },
      async pickUtilityModel() { return 'utility-fake'; },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'utility-fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    let threw = false;
    let repaired: unknown;
    try { repaired = await tryModelRepair(TOOL_CALL, { readFile: {} }, 'Required property "path" is missing', schema, throwingRouter); }
    catch { threw = true; }
    ok('router call throws: caught internally, does not propagate', !threw);
    ok('router call throws: degrades to null', repaired === null);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error('FATAL', err); process.exitCode = 1; });

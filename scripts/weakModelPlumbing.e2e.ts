/* Weak-model plumbing (2026-09-06, from the AI SDK's "Prompts for Tools" tips): null-valued
 * optional params are stripped before any model repair; inputExamples reach the OpenAI-shaped
 * wire inside the description; reasoning models never receive a temperature; a short follow-up
 * inherits the previous turn's task kind. Run: npm run test:e2e:weak-model-plumbing */
import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { withoutNullKeys, resolveToolAlias, makeRepairViaModelSelfCorrection } from '../src/agent/core/repair';
import { classifyConversation } from '../src/agent/routing';
import { OpenAIResponsesProvider } from '../src/providers/openai-responses';
import { OpenAICompatProvider } from '../src/providers/openai-compat';
import { isDegenerateRepeat } from '../src/agent/core/routerProvider';
import { rescueInlineToolCalls, adoptInlineToolCalls, repairToolArguments } from '../src/agent/toolArgs';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

async function main() {
  console.log('— null-valued optional params are stripped, nothing else touched —');
  ok('1. nulls removed', withoutNullKeys('{"path":"a.ts","offset":null,"limit":null}') === '{"path":"a.ts"}');
  ok('2. nothing null → undefined (no repair needed)', withoutNullKeys('{"path":"a.ts"}') === undefined);
  ok('3. malformed JSON → undefined (model repair takes over)', withoutNullKeys('{"path":') === undefined);
  ok('4. nested nulls left alone (only top-level keys)', withoutNullKeys('{"edits":[{"search":"a","replace":null}],"x":null}') === '{"edits":[{"search":"a","replace":null}]}');

  console.log('— inputExamples ride in the wire description —');
  {
    const captured: { body?: string } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
      captured.body = init?.body;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { createRouterProvider } = await import('../src/agent/core/routerProvider');
    const { setModelSources, recordOutcome } = await import('../src/router/picker');
    setModelSources({
      catalog: { find: () => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }) },
      settings: { getFallback: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }], getDisabledProviders: () => [], enabledByPriority: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }] },
      secrets: { getKeys: async () => ['k'], getCloudflareAccountId: async () => undefined, isToolIncompatible: () => false },
    } as never);
    recordOutcome('groq', 'm', true);
    const p = createRouterProvider({ taskKind: 'chat' });
    await p.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'readFile', description: 'Read a file.', inputSchema: { type: 'object' }, inputExamples: [{ input: { path: 'src/a.ts' } }] }],
    } as never);
    globalThis.fetch = realFetch;
    const desc = (JSON.parse(captured.body ?? '{}') as { tools?: Array<{ function: { description: string } }> }).tools?.[0]?.function.description ?? '';
    ok('5. description keeps its text', desc.startsWith('Read a file.'));
    ok('6. …and carries the example as JSON', desc.includes('Input examples:') && desc.includes('{"path":"src/a.ts"}'), desc);
  }

  console.log('— reasoning models get no temperature; others do —');
  {
    const resp = new OpenAIResponsesProvider({ platform: 'openai', name: 'x', baseUrl: 'https://x' } as never) as unknown as { buildBody: (m: unknown[], id: string, o: unknown, s: boolean) => string };
    const gpt5 = JSON.parse(resp.buildBody([{ role: 'user', content: 'hi' }], 'gpt-5.2', { temperature: 0 }, false));
    const gpt4 = JSON.parse(resp.buildBody([{ role: 'user', content: 'hi' }], 'gpt-4.1', { temperature: 0 }, false));
    ok('7. Responses API: gpt-5 body has no temperature', !('temperature' in gpt5));
    ok('8. Responses API: gpt-4.1 body keeps the temperature', gpt4.temperature === 0);
    const compat = new OpenAICompatProvider({ platform: 'groq', name: 'g', baseUrl: 'https://g' } as never) as unknown as { buildBody: (m: unknown[], id: string, o: unknown, s: boolean) => string };
    const oss = JSON.parse(compat.buildBody([{ role: 'user', content: 'hi' }], 'openai/gpt-oss-120b', { temperature: 0 }, false));
    const o3 = JSON.parse(compat.buildBody([{ role: 'user', content: 'hi' }], 'openai/o3', { temperature: 0 }, false));
    ok('9. compat: gpt-oss keeps temperature 0', oss.temperature === 0);
    ok('10. compat: o3 via a gateway gets none', !('temperature' in o3));
  }

  console.log('— a short follow-up inherits the working task kind —');
  ok('11. debug question stays debug', classifyConversation(['100058 order why minus in distance? and why vehicle id not set?']).kind === 'agent' || classifyConversation(['order 100058 is broken: distance is negative']).kind === 'debug');
  ok('12. "is this correct?" after a debug turn → debug', classifyConversation(['order 100058 is broken: distance is negative', 'is this the correct answer?']).kind === 'debug');
  ok('13. "issue ki?" after a coding turn → coding', classifyConversation(['refactor the getDeliveryCharge function in PlaceNewOrder.php', 'issue ki?']).kind === 'coding');
  ok('14. a long new question is classified on its own', classifyConversation(['fix the failing cart test', 'can you explain in general how laravel middleware ordering is decided for a request']).kind === 'chat');
  ok('15. a follow-up after a plain chat stays chat', classifyConversation(['what is a closure?', 'and a monad?']).kind === 'chat');
  ok('16. a greeting in between is skipped', classifyConversation(['the build is broken', 'thanks', 'and now?']).kind === 'debug');

  console.log('— a decoding loop is cut —');
  const para = 'Let me check if there is a different issue with the distance validation. The original validation was required_unless, which means it is not required for take_away orders. But the user is asking about a negative distance value.\n\n';
  ok('17. the same paragraph three times is a loop', isDegenerateRepeat('Intro text. ' + para.repeat(3)));
  ok('18. twice is not (a legitimate restatement)', !isDegenerateRepeat('Intro text. ' + para.repeat(2)));
  ok('19. long varied prose is not', !isDegenerateRepeat(Array.from({ length: 40 }, (_, i) => `Finding ${i}: value ${i * 7} differs from ${i * 3}.`).join(' ')));

  console.log('— token-level collapse (live repro 2026-11-11: function. Function. f f f. functions.) —');
  // The live shape: case and spelling churn on every repetition, so no byte-identical tail ever
  // forms — the exact-suffix check above cannot fire on this class.
  const churn = Array.from({ length: 90 }, (_, i) => (i % 7 === 0 ? 'functions' : i % 3 === 0 ? 'Function' : i % 5 === 0 ? 'f f f f' : 'function')).join('. ') + '. ';
  ok('17a. varied-case token churn collapses (the live repro)', isDegenerateRepeat(churn), churn.slice(0, 80));
  ok('17b. one word over half the reply is a collapse', isDegenerateRepeat('alpha '.repeat(120) + 'beta. '), '');
  ok('17c. vocabulary collapse without a dominant word is caught too', isDegenerateRepeat(Array.from({ length: 320 }, (_, i) => ['x', 'y', 'z', 'w', 'q', 'v', 'u', 'k'][i % 8]).join(' ')));
  ok('17d. under 600 chars the guard stays silent (short replies are not judged)', !isDegenerateRepeat('function. Function. f f f. '.repeat(8)));
  ok('17e. a long healthy identifier list is not a collapse', !isDegenerateRepeat(Array.from({ length: 110 }, (_, i) => `handler${i}`).join(', ')));
  ok('17f. prose repeating one common word often is still fine', !isDegenerateRepeat(Array.from({ length: 40 }, (_, i) => `The file ${i} uses the parser and the ${i}th test checks the parser output for file ${i}.`).join(' ')));
  ok('20. "why X not set?" routes as debug', classifyConversation(['100058 order why minus in distance? and why vehicles id not set here?']).kind === 'debug');

  console.log('— another harness\'s tool names resolve without a model call —');
  {
    const OFFERED = ['readFile', 'writeFile', 'editFile', 'deleteFile', 'glob', 'grep', 'listDir', 'runCommand', 'delegateTask', 'fetchUrl', 'webSearch', 'todoWrite', 'askUser', 'getDiagnostics'];
    const a = (n: string) => resolveToolAlias(n, OFFERED);
    // Nobody writes a skill or an agent file for TierMux, so a model following one calls the
    // tools by the name its author's harness used.
    ok('21. Claude Code names', a('Read') === 'readFile' && a('Bash') === 'runCommand' && a('Task') === 'delegateTask' && a('WebFetch') === 'fetchUrl');
    ok('22. Codex / Anthropic API names', a('apply_patch') === 'editFile' && a('str_replace_editor') === 'editFile' && a('shell') === 'runCommand');
    ok('23. OpenCode / Cline names', a('read') === 'readFile' && a('list_files') === 'listDir' && a('execute_command') === 'runCommand');
    ok('24. only case or separators differ', a('ReadFile') === 'readFile' && a('read_file') === 'readFile' && a('todo-write') === 'todoWrite');
    ok('25. an unknown name still goes to the model', a('Nonsense') === undefined && a('mcp__srv__tool') === undefined);
    ok('26. an alias for a tool this mode does not offer is not invented',
      resolveToolAlias('Bash', ['readFile', 'grep']) === undefined);

    // agentBench 2026-11-04: `search {path, query}` became grep with no `pattern`, failed validation,
    // and burned 14 of 26 steps at ~40s each.
    const { repair } = makeRepairViaModelSelfCorrection({ model: undefined as never });
    const fix = (toolName: string, input: string, error: unknown) => repair({
      toolCall: { type: 'tool-call', toolCallId: 'c', toolName, input }, tools: { grep: {} } as never, inputSchema: async () => ({}), error, messages: [],
    } as never);
    const named = await fix('search', '{"path":"src","query":"x"}', new NoSuchToolError({ toolName: 'search' }));
    ok('27. an aliased tool gets its argument names too', named?.toolName === 'grep' && JSON.parse(named.input).pattern === 'x' && !('query' in JSON.parse(named.input)), JSON.stringify(named));
    const argsOnly = await fix('grep', '{"path":"src","query":"x"}', new InvalidToolInputError({ toolName: 'grep', toolInput: '{}', cause: new Error('bad') }));
    ok('28. a right tool name with an imagined argument name needs no model call', JSON.parse(argsOnly?.input ?? '{}').pattern === 'x', JSON.stringify(argsOnly));

    // 2026-11-12 (OpenCode tool-input-repair / Cline normalizeJsonLikeStringsForSchema parity):
    // quoted scalars and a stringified array are coerced against the schema with no model call.
    const schemaFix = (toolName: string, input: string, schema: unknown) => repair({
      toolCall: { type: 'tool-call', toolCallId: 'c', toolName, input }, tools: { [toolName]: {} } as never,
      inputSchema: async () => schema, error: new InvalidToolInputError({ toolName, toolInput: input, cause: new Error('bad') }), messages: [],
    } as never);
    const readSchema = { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } };
    const q = await schemaFix('readFile', '{"path":"a.ts","offset":"10","limit":null}', readSchema);
    ok('29. quoted number coerced AND null stripped in one no-model pass', q !== null && JSON.parse(q.input).offset === 10 && !('limit' in JSON.parse(q.input)), JSON.stringify(q));
    const bg = await schemaFix('runCommand', '{"command":"npm run dev","background":"true"}', { type: 'object', properties: { command: { type: 'string' }, background: { type: 'boolean' } } });
    ok('30. quoted boolean coerced', bg !== null && JSON.parse(bg.input).background === true, JSON.stringify(bg));
    const editSchema = { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { search: { type: 'string' }, replace: { type: 'string' } } } } } };
    const st = await schemaFix('editFile', JSON.stringify({ path: 'a.ts', edits: JSON.stringify([{ search: 'a', replace: 'b' }]) }), editSchema);
    ok('31. stringified edits[] un-stringified on a NATIVE call', st !== null && Array.isArray(JSON.parse(st.input).edits), JSON.stringify(st));
    ok('32. an unparseable scalar is not guessed', repairToolArguments('{"path":"a.ts","offset":"ten"}', readSchema) === '{"path":"a.ts","offset":"ten"}');
    // A call cut off by the output-token limit: no LLM repair (it would truncate again).
    const cut = await schemaFix('writeFile', '{"path":"big.ts","content":"line1\\nline2\\n', { type: 'object', properties: {} });
    ok('33. a truncated tool call skips the model repair', cut === null, JSON.stringify(cut));
  }

  console.log('— the @@-block dialect (xKiro stealth/big-pickle, live 2026-11-12) —');
  {
    const NAMES = new Set(['readFile', 'grep', 'runCommand', 'editFile']);
    // The live shape: @@CALL_TOOL / @@ARG key@@value@@END_ARG / @@END_CALL, name sometimes quoted,
    // parameters as named @@ARGs or ONE JSON object, and the block often unterminated mid-stream.
    const named =
      'Let me check that file.\n\n@@CALL_TOOL\n@@ARG tool_name@@"read"@@END_ARG\n@@ARG file@@src/app.ts@@END_ARG\n@@END_CALL\n';
    const r1 = rescueInlineToolCalls(named, NAMES);
    ok('27. named @@ARGs adopt, alias read→readFile, file→path',
      r1.detected && r1.calls[0]?.name === 'readFile' && JSON.parse(r1.calls[0].arguments).path === 'src/app.ts',
      JSON.stringify(r1.calls));
    const asObject =
      '@@CALL_TOOL\n@@ARG tool_name@@grep@@END_ARG\n@@ARG arguments@@{"pattern":"killTree","path":"src"}@@END_ARG\n@@END_CALL';
    const r2 = rescueInlineToolCalls(asObject, NAMES);
    ok('28. a JSON-object parameter lifts as the arguments',
      r2.calls[0]?.name === 'grep' && JSON.parse(r2.calls[0].arguments).pattern === 'killTree', JSON.stringify(r2.calls));
    const unterminated = '@@CALL_TOOL\n@@ARG tool_name@@runCommand@@END_ARG\n@@ARG command@@git status@@END_ARG';
    const r3 = rescueInlineToolCalls(unterminated, NAMES);
    ok('29. an unterminated block still adopts (chunk cut mid-call)',
      r3.calls[0]?.name === 'runCommand' && JSON.parse(r3.calls[0].arguments).command === 'git status', JSON.stringify(r3.calls));
    const two = '@@CALL_TOOL\n@@ARG tool_name@@read@@END_ARG\n@@ARG file@@a.ts@@END_ARG\n@@END_CALL\nmid-text\n@@CALL_TOOL\n@@ARG tool_name@@read@@END_ARG\n@@ARG file@@b.ts@@END_ARG\n@@END_CALL\n';
    const r4 = rescueInlineToolCalls(two, NAMES);
    ok('30. two blocks → two calls, in order',
      r4.calls.length === 2 && JSON.parse(r4.calls[1].arguments).path === 'b.ts', JSON.stringify(r4.calls));
    const unknown = '@@CALL_TOOL\n@@ARG tool_name@@dance@@END_ARG\n@@ARG style@@free@@END_ARG\n@@END_CALL\n';
    const r5 = rescueInlineToolCalls(unknown, NAMES);
    ok('31. an unregistered tool is not invented', !r5.detected || r5.calls.length === 0, JSON.stringify(r5.calls));
    const tools = [
      { type: 'function', function: { name: 'readFile', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    ];
    const noAngle = 'Sure.\n@@CALL_TOOL\n@@ARG tool_name@@readFile@@END_ARG\n@@ARG path@@README.md@@END_ARG\n@@END_CALL\n';
    const adopted = adoptInlineToolCalls(noAngle, [], tools);
    ok('32. adoptInlineToolCalls no longer needs a `<` in the text',
      !!adopted && adopted[0]?.name === 'readFile' && JSON.parse(adopted[0].args).path === 'README.md', JSON.stringify(adopted));
    const plain = 'The killTree function lives in shell.ts and is used by the registry. No calls needed here.';
    ok('33. prose without blocks is untouched', rescueInlineToolCalls(plain, NAMES).detected === false);
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

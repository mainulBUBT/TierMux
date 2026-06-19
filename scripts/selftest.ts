// Standalone runtime sanity checks for the vscode-free logic modules.
// Run: node esbuild bundle (see command). Not part of the shipped extension.
import { repairToolArguments, rescueInlineToolCalls, toolSchemaMap } from '../src/agent/toolArgs';
import { contentToString, messagesHaveImage } from '../src/agent/content';
import { Catalog } from '../src/catalog/catalog';
import { cleanCommitMessage, looksLikeGarbage, buildTemplateFallback } from '../src/scm/commitMessageClean';
import { splitReasoningStandalone } from './_split';
import * as path from 'path';

let failures = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// repairToolArguments: nested-JSON-as-string against an array schema.
const schema = { type: 'object', properties: { items: { type: 'array' } } };
ok('repair double-encoded array', repairToolArguments('{"items":"[1,2,3]"}', schema) === '{"items":[1,2,3]}');
ok('repair leaves valid args', repairToolArguments('{"items":[1]}', schema) === '{"items":[1]}');
ok('repair leaves plain string param', repairToolArguments('{"q":"[hi]"}', { type: 'object', properties: { q: { type: 'string' } } }) === '{"q":"[hi]"}');

// rescueInlineToolCalls
const r = rescueInlineToolCalls('blah <function=readFile>{"path":"a.ts"}</function> end', new Set(['readFile']));
ok('rescue function-tag', r.detected && r.calls[0].name === 'readFile');
const r2 = rescueInlineToolCalls('{"name":"writeFile","arguments":{"path":"b"}}', new Set(['writeFile']));
ok('rescue name/arguments blob', r2.detected && r2.calls[0].name === 'writeFile');

// toolSchemaMap
const map = toolSchemaMap([{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }]);
ok('toolSchemaMap maps by name', map.has('x'));

// content
ok('contentToString string', contentToString('hi') === 'hi');
ok('contentToString blocks', contentToString([{ type: 'text', text: 'a' }, { text: 'b' }]) === 'ab');
ok('messagesHaveImage true', messagesHaveImage([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }]));
ok('messagesHaveImage false', !messagesHaveImage([{ role: 'user', content: 'plain' }]));

// splitReasoning (logic copy)
const sr = splitReasoningStandalone('<think>because</think>Answer');
ok('splitReasoning extracts think', sr.reasoning === 'because' && sr.content === 'Answer');

// Catalog: load the real seed and derive a default fallback chain.
const cat = new Catalog(path.resolve(__dirname, '..'));
ok('catalog loads models', cat.all().length > 10);
const fb = cat.defaultFallback();
ok('default fallback covers all models', fb.length === cat.all().length);
ok('fallback priority ordered', fb.every((e, i) => e.priority === i));
ok('all platforms resolve', cat.all().every((m) => typeof m.platform === 'string' && typeof m.modelId === 'string'));

// commitMessageClean: pure helpers for cleaning + validating model output.
ok('clean: strips JSON wrapper',
  cleanCommitMessage('{"message":"feat: add OAuth"}') === 'feat: add OAuth');
ok('clean: strips JSON subject field',
  cleanCommitMessage('{"subject": "feat: add OAuth", "body": "details"}') === 'feat: add OAuth');
ok('clean: strips code fence',
  cleanCommitMessage('```\nfeat: add OAuth\n```') === 'feat: add OAuth');
ok('clean: strips language-tagged fence',
  cleanCommitMessage('```text\nfix: handle null\n```') === 'fix: handle null');
ok('clean: strips preamble "Here is"',
  cleanCommitMessage("Here's a commit message:\nfeat: add OAuth") === 'feat: add OAuth');
ok('clean: strips preamble "Sure,"',
  cleanCommitMessage("Sure, here's a commit message for you:\nfix: typo") === 'fix: typo');
ok('clean: strips preamble "Subject:"',
  cleanCommitMessage("Subject: feat: add OAuth") === 'feat: add OAuth');
ok('clean: strips markdown header',
  cleanCommitMessage('# Commit message\n\nfeat: add OAuth') === 'feat: add OAuth');
ok('clean: strips bold label',
  cleanCommitMessage('**Subject:** feat: add OAuth') === 'feat: add OAuth');
ok('clean: collapses repeated lines',
  cleanCommitMessage('feat: add\nfeat: add\nfeat: add') === 'feat: add');
ok('clean: strips think block',
  cleanCommitMessage('<think>reasoning here</think>feat: add OAuth') === 'feat: add OAuth');
ok('clean: strips blockquote',
  cleanCommitMessage('> feat: add OAuth') === 'feat: add OAuth');
ok('clean: keeps good message with body',
  cleanCommitMessage('feat: add OAuth\n\nAdds OAuth2 auth.') === 'feat: add OAuth\n\nAdds OAuth2 auth.');
ok('clean: trims rambles to 2 paragraphs',
  cleanCommitMessage('feat: add X\n\nBody 1\n\nBody 2\n\nBody 3') === 'feat: add X\n\nBody 1');

ok('garbage: empty', looksLikeGarbage(''));
ok('garbage: whitespace only', looksLikeGarbage('   \n  '));
ok('garbage: too short', looksLikeGarbage('hi'));
ok('garbage: too long', looksLikeGarbage('a'.repeat(3000)));
ok('garbage: control chars', looksLikeGarbage('feat: add\u0000\u0001'));
ok('garbage: refusal "I cannot"', looksLikeGarbage('I cannot generate a commit message'));
ok('garbage: refusal "As an AI"', looksLikeGarbage('As an AI, I am unable to...'));
ok('garbage: refusal "I am sorry"', looksLikeGarbage("I'm sorry, I can't help with that"));
ok('garbage: repeated lines', looksLikeGarbage('feat: add\nfeat: add\nfeat: add'));
ok('garbage: mostly quoted block', looksLikeGarbage('> line 1\n> line 2\n> line 3\n> line 4\n> line 5'));
ok('garbage: single noise word', looksLikeGarbage('asdf'));

ok('good: simple subject', !looksLikeGarbage('feat: add OAuth login flow'));
ok('good: subject with body', !looksLikeGarbage('feat: add OAuth\n\nAdds OAuth2 auth.'));
ok('good: fix prefix', !looksLikeGarbage('fix: handle null user'));
ok('good: scoped prefix', !looksLikeGarbage('feat(router): add rate limiting'));
ok('good: imperative no-prefix', !looksLikeGarbage('Add OAuth login flow to auth module'));

// buildTemplateFallback: deterministic message from file paths.
const fakeDiff = [
  'diff --git a/src/router/router.ts b/src/router/router.ts',
  'index 123..456 100644',
  '--- a/src/router/router.ts',
  '+++ b/src/router/router.ts',
  '@@ -1,3 +1,5 @@',
  '-old line',
  '+new line 1',
  '+new line 2',
  'diff --git a/src/config/secrets.ts b/src/config/secrets.ts',
  '@@ -10,2 +10,3 @@',
  '-old',
  '+new',
  ' unchanged',
].join('\n');
const fallback = buildTemplateFallback(fakeDiff);
ok('template: includes "chore:"', fallback.startsWith('chore:'));
ok('template: includes 2 files', fallback.includes('2 file(s)'));
ok('template: lists paths', fallback.includes('src/router/router.ts') && fallback.includes('src/config/secrets.ts'));
ok('template: empty diff yields placeholder', buildTemplateFallback('') === 'chore: update workspace');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

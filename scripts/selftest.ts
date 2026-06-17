// Standalone runtime sanity checks for the vscode-free logic modules.
// Run: node esbuild bundle (see command). Not part of the shipped extension.
import { repairToolArguments, rescueInlineToolCalls, toolSchemaMap } from '../src/agent/toolArgs';
import { contentToString, messagesHaveImage } from '../src/agent/content';
import { Catalog } from '../src/catalog/catalog';
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

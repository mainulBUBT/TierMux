import { composeSystemPrompt } from '../src/context/system';
import { buildV3ToolSet } from '../src/agent/core/tools/v3/index';

const sys = composeSystemPrompt('agent');
console.log('SYSTEM_PROMPT chars:', sys.length, '≈tokens:', Math.round(sys.length / 4));

const tools = buildV3ToolSet('agent', {} as any) as Record<string, any>;
let desc = 0, schema = 0;
const names = Object.keys(tools);
for (const n of names) {
  const t = tools[n];
  const d = typeof t.description === 'string' ? t.description : '';
  desc += d.length;
  const s = JSON.stringify(t.inputSchema ?? t.parameters ?? {});
  schema += s.length;
}
console.log('TOOLS:', names.length, '→', names.join(', '));
console.log('tool descriptions chars:', desc, '≈tokens:', Math.round(desc / 4));
console.log('tool schemas chars:', schema, '≈tokens:', Math.round(schema / 4));

/* Sub-agent registry (2026-09-07): built-in agents plus `.tiermux/agents/*.md`, the same
 * frontmatter shape skills use. A workspace file replaces a built-in of the same name; an
 * agent's `tools` list narrows what it may call. Run: npm run test:e2e:agent-registry */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAgents, invalidateAgentsCache, BUILTIN_AGENTS } from '../src/agent/agents';
import { runSubagent } from '../src/agent/core/subagent';
import { buildV3ToolSet } from '../src/agent/core/tools/v3/index';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { createMockModel } from './mockModel';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

function workspace(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-agents-'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'alpha\nbeta\n');
  const dir = path.join(root, '.tiermux', 'agents');
  if (Object.keys(files).length) fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  invalidateAgentsCache();
  return root;
}

async function main() {
  console.log('— built-ins are always available —');
  {
    invalidateAgentsCache();
    const agents = loadAgents(undefined);
    ok('1. explore and review ship built in', agents.has('explore') && agents.has('review'), [...agents.keys()].join(','));
    ok('2. every built-in has a description the caller can act on',
      BUILTIN_AGENTS.every((a) => a.description.length > 20 && a.prompt.length > 200));
    ok('3. explore is read-only in its own words', /read-only/i.test(agents.get('explore')!.prompt));
  }

  console.log('— a workspace file adds an agent —');
  {
    const root = workspace({
      'triage.md': `---
description: Triage a failing test and report the first broken assumption.
tools: [readFile, grep, runCommand]
taskKind: debug
maxSteps: 5
---
You are the Triage agent. Report the first assumption that does not hold.`,
    });
    const agents = loadAgents(root);
    const t = agents.get('triage')!;
    ok('4. the file is registered under its filename', !!t, [...agents.keys()].join(','));
    ok('5. description parsed', t.description.startsWith('Triage a failing test'));
    ok('6. inline tools list parsed', JSON.stringify(t.tools) === '["readFile","grep","runCommand"]', JSON.stringify(t.tools));
    ok('7. taskKind and maxSteps parsed', t.taskKind === 'debug' && t.maxSteps === 5, `${t.taskKind}/${t.maxSteps}`);
    ok('8. body is the prompt, frontmatter stripped', t.prompt.startsWith('You are the Triage agent') && !t.prompt.includes('---'));
    ok('9. built-ins survive alongside it', agents.has('explore') && agents.has('review'));
  }

  console.log('— YAML block list, and replacing a built-in —');
  {
    const root = workspace({
      'explore.md': `---
description: Project-specific exploration.
model: groq::openai/gpt-oss-120b
tools:
  - readFile
  - glob
---
Explore this project the way its maintainers do.`,
    });
    const e = loadAgents(root).get('explore')!;
    ok('10. a workspace explore.md replaces the built-in', e.prompt.startsWith('Explore this project'));
    ok('11. block-style tools list parsed', JSON.stringify(e.tools) === '["readFile","glob"]', JSON.stringify(e.tools));
    ok('12. model pin parsed', e.model === 'groq::openai/gpt-oss-120b');
  }

  console.log('— the tools list narrows what the sub-agent may call —');
  {
    const root = workspace({
      'narrow.md': `---
description: Reads one file and stops.
tools: [readFile]
---
Read and report.`,
    });
    const model = createMockModel([{ text: 'done' }], 'narrow');
    const r = await runWithWorkspaceRoot(root, () => runSubagent({ task: 'x', agent: 'narrow', model: model as never, maxSteps: 1 }));
    ok('13. only the named tool is offered', JSON.stringify(model.calls[0].tools) === '["readFile"]', JSON.stringify(model.calls[0].tools));
    ok('14. the report names the agent that ran', r.agent === 'narrow', r.agent);
  }

  console.log('— an agent naming only unknown tools still gets the default set —');
  {
    const root = workspace({
      'broken.md': `---
description: Names tools that do not exist.
tools: [teleport, timeTravel]
---
Try anyway.`,
    });
    const model = createMockModel([{ text: 'done' }], 'broken');
    await runWithWorkspaceRoot(root, () => runSubagent({ task: 'x', agent: 'broken', model: model as never, maxSteps: 1 }));
    ok('15. falls back to the full read-only set rather than running blind',
      model.calls[0].tools.includes('readFile') && model.calls[0].tools.includes('grep'), JSON.stringify(model.calls[0].tools));
    ok('16. and still nothing that mutates',
      !model.calls[0].tools.some((t) => ['editFile', 'writeFile', 'deleteFile'].includes(t)));
  }

  console.log('— an unknown agent name falls back to explore —');
  {
    const root = workspace();
    const model = createMockModel([{ text: 'done' }], 'unknown');
    const r = await runWithWorkspaceRoot(root, () => runSubagent({ task: 'x', agent: 'nope', model: model as never, maxSteps: 1 }));
    ok('17. unknown name → explore', r.agent === 'explore', r.agent);
    const noName = createMockModel([{ text: 'done' }], 'default');
    const r2 = await runWithWorkspaceRoot(root, () => runSubagent({ task: 'x', model: noName as never, maxSteps: 1 }));
    ok('18. no name → explore', r2.agent === 'explore', r2.agent);
  }

  console.log('— the roster reaches the model through delegateTask —');
  {
    const root = workspace({ 'triage.md': '---\ndescription: Triage a failing test.\n---\nBody.' });
    const desc = await runWithWorkspaceRoot(root, async () => {
      const tools = buildV3ToolSet('agent') as Record<string, { description?: string }>;
      return tools.delegateTask?.description ?? '';
    });
    ok('19. every agent is listed with its description', desc.includes('`explore`') && desc.includes('`review`') && desc.includes('Triage a failing test'), desc.slice(-160));
    ok('20. the "no context" instruction survives', desc.includes('never seen this conversation'));
    ok('21. internal agents are not offered', !desc.includes('`audit`'));
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

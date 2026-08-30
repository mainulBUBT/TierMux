/* The tool offer is sized to the serving model's context window.
 *
 * Measured 2026-08-30: the agent toolset serializes to ~3,570 tokens of JSON Schema on EVERY
 * request (14 tools; webSearch 533, readFile 505, todoWrite 470, editFile 396, delegateTask
 * 270 …). Against an 8k-window model — whose whole compaction budget is 6,963 — that is 51%
 * of the budget spent before a single message is sent.
 *
 * The fix is `activeTools` in prepareStep, and the interesting half is what it does NOT drop.
 * Only the two COORDINATION tools go: the model still reads, searches, edits, runs commands
 * and browses, it just doesn't keep a todo list or spawn a sub-agent. The web tools are the
 * single largest schema in the set and are deliberately kept — tools/v3/index.ts records that
 * they were "restored from the v2 toolset after live deflections", i.e. withdrawing a
 * capability makes the model refuse the task rather than do it more cheaply.
 *
 * Run: npm run test:e2e:tool-offer
 */
import { createMockModel } from '../src/agent/poc/mockModel';
import { runAgentStream } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { setModelSources } from '../src/router/picker';
import type { AgentOpts } from '../src/agent/agent';
import type { CatalogModel } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const WINDOWS: Record<string, number> = { small: 8_192, mid: 16_384, big: 200_000 };

setModelSources({
  catalog: {
    find: (platform: string): CatalogModel | undefined => (WINDOWS[platform] === undefined
      ? undefined
      : ({ platform, modelId: 'm', intelligenceRank: 3, contextWindow: WINDOWS[platform], supportsTools: true } as unknown as CatalogModel)),
  },
  settings: { getFallback: () => [], getDisabledProviders: () => [], enabledByPriority: () => [] },
  secrets: { getKeys: async () => [], isToolIncompatible: () => false },
} as unknown as Parameters<typeof setModelSources>[0]);

/** Runs one engine turn with a pinned model and returns the tool names actually offered. */
async function offeredFor(platform: string): Promise<string[]> {
  const model = createMockModel([{ text: 'done' }], `offer-${platform}`);
  __setEngineModelForTests(model);
  try {
    await runAgentStream(undefined as never, {
      messages: [{ role: 'user', content: 'hello' }],
      mode: 'agent',
      effort: 'medium',
      pinnedModel: `${platform}::m`,
      onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
      onFailover: () => {}, onStep: () => {}, onTodos: () => {},
      onAskUser: async () => 'yes', onError: () => {},
    } as unknown as AgentOpts);
  } finally {
    __setEngineModelForTests(undefined);
  }
  return model.calls[0].tools;
}

async function main() {
const CAPABILITY = ['readFile', 'editFile', 'writeFile', 'grep', 'glob', 'listDir', 'runCommand', 'webSearch', 'fetchUrl', 'getDiagnostics'];

console.log('— a small window sheds the coordination tools —');
{
  const offered = await offeredFor('small');
  ok('todoWrite withdrawn', !offered.includes('todoWrite'), offered.join(','));
  ok('delegateTask withdrawn', !offered.includes('delegateTask'), offered.join(','));
  ok('every capability tool survives',
    CAPABILITY.every((t) => offered.includes(t)),
    CAPABILITY.filter((t) => !offered.includes(t)).join(',') || 'none missing');
  ok('webSearch kept despite being the largest schema', offered.includes('webSearch'));
}

console.log('\n— a large window keeps the full offer —');
{
  const offered = await offeredFor('big');
  ok('todoWrite offered', offered.includes('todoWrite'), offered.join(','));
  ok('delegateTask offered', offered.includes('delegateTask'), offered.join(','));
}

console.log('\n— the threshold is inclusive at 16k —');
{
  const offered = await offeredFor('mid');
  ok('a 16k model is still treated as small', !offered.includes('todoWrite'), offered.join(','));
}

console.log('\n— an uncatalogued model falls back to the full offer —');
{
  const offered = await offeredFor('unknown-platform');
  ok('unknown model is not penalised', offered.includes('todoWrite'), offered.join(','));
}

console.log(bad === 0 ? '\nTool offer sizing holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();

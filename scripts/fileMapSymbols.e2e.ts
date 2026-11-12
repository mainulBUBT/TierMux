/* The symbol sketch: one repo-wide rg pass over declaration shapes (multi-language), the
 * agent/ask budget rule (off below 16k, ~2.5% with floor/ceiling), freshness ordering (a
 * just-touched file leads, so active work survives the budget cut), honest truncation, and the
 * prompt-context wiring (setting off → no block; plan renders the annotated tree, agent/ask the
 * flat sketch, an unbudgeted context adds nothing).
 * Merged 2026-11-12 with the repo-wide DECLARATION_PATTERN extraction — const/let ARE declared
 * names now, indented (method-level) declarations are NOT (the pattern anchors at column 0).
 * Run: npm run test:e2e:file-map-symbols */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  gatherProjectMap, formatSymbolMap, formatFileMap, symbolBudgetForWindow, attachSymbolsToMap,
} from '../src/context/fileMap';
import { gatherPromptContext, invalidatePromptContext } from '../src/context/promptContext';
import { composeSystemPrompt } from '../src/context/system';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `   (${detail})` : ''}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-syms-'));
  const put = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };

  console.log('— Extraction: top-level declaration shapes, across languages —');
  put('src/app.ts', `export function alpha(): void {}
export interface Shape { sides: number }
export class Widget {
  render() {}
}
type Pair = [number, number];
const handler = async (x: number) => x + 1;
const notJustAFunction = 42;
let counter = 0;
`);
  put('lib/model.py', `class Model:
    def train(self):
        pass

def run_epoch(loader):
    return 0
`);
  put('svc/order.go', `package svc

func PlaceOrder(u User) error { return nil }

type Order struct { ID int }
`);
  put('notes/readme.md', `# not source
function fake() {}
`);
  await runWithWorkspaceRoot(root, async () => {
    const map = await gatherProjectMap();
    check('map gathered', !!map);
    if (!map) return;
    const ts = map.symbols.get('src/app.ts') ?? [];
    const py = map.symbols.get('lib/model.py') ?? [];
    const go = map.symbols.get('svc/order.go') ?? [];
    check('ts: function extracted', ts.includes('alpha'), ts.join(','));
    check('ts: interface extracted', ts.includes('Shape'), ts.join(','));
    check('ts: class extracted', ts.includes('Widget'), ts.join(','));
    check('ts: type alias extracted (the Go shape covers it)', ts.includes('Pair'), ts.join(','));
    check('ts: const/let are declared names', ts.includes('handler') && ts.includes('notJustAFunction') && ts.includes('counter'), ts.join(','));
    check('py: top-level class + def extracted', py.includes('Model') && py.includes('run_epoch'), py.join(','));
    check('py: indented methods are not (pattern anchors at column 0)', !py.includes('train'), py.join(','));
    check('go: func + type extracted', go.includes('PlaceOrder') && go.includes('Order'), go.join(','));
    check('markdown ignored entirely', !map.symbols.has('notes/readme.md'));
    check('plan-mode annotation rides the name map', attachSymbolsToMap(formatFileMap(map.files), map.symbols).includes('app.ts [alpha, Shape'), attachSymbolsToMap(formatFileMap(map.files), map.symbols).split('\n').find((l) => l.includes('app.ts')) ?? '');

    console.log('\n— Freshness ordering and budget truncation —');
    await sleep(10);
    put('lib/model.py', `class Fresh:\n    pass\n`);
    const fresh = await gatherProjectMap();
    const rendered = formatSymbolMap(fresh, 10_000);
    const lines = rendered.split('\n');
    check('just-touched file leads the map', lines[0]?.startsWith('lib/model.py'), lines[0]);
    check('fresher symbols replaced stale ones', rendered.includes('Fresh') && !rendered.includes('run_epoch'), rendered.slice(0, 200));
    const tight = formatSymbolMap(fresh, 40);
    check('tight budget cuts with an honest footer', /more source files not shown/.test(tight), tight);

    console.log('\n— Window → budget: off for small models, ~2.5% with floor and ceiling —');
    check('8k window: off (sketch would crowd real content)', symbolBudgetForWindow(8192) === undefined);
    check('null window: off', symbolBudgetForWindow(null) === undefined);
    check('16k window: floored', symbolBudgetForWindow(16_384) === 2_000, String(symbolBudgetForWindow(16_384)));
    check('131k window: 2.5% ≈ 3276', symbolBudgetForWindow(131_072) === 3_276, String(symbolBudgetForWindow(131_072)));
    check('1M window: ceilinged at 12k', symbolBudgetForWindow(1_048_576) === 12_000, String(symbolBudgetForWindow(1_048_576)));

    console.log('\n— Prompt wiring: plan gets the annotated tree, agent/ask the flat sketch, the setting kills it —');
    invalidatePromptContext();
    (globalThis as Record<string, unknown>).__tiermuxTestConfig = {};
    const ctx = await gatherPromptContext(4_000);
    check('context carries both maps', !!ctx.fileMap && !!ctx.symbolMap);
    check('plan-mode fileMap is symbol-annotated', ctx.fileMap?.includes('app.ts [') === true, (ctx.fileMap ?? '').split('\n').find((l) => l.includes('app.ts')) ?? '');
    check('symbolMap honors the budget', (ctx.symbolMap?.length ?? 0) <= 4_200, String(ctx.symbolMap?.length));
    const agentPrompt = composeSystemPrompt('agent', ctx);
    const askPrompt = composeSystemPrompt('ask', ctx);
    const planPrompt = composeSystemPrompt('plan', ctx);
    check('agent prompt shows the sketch', agentPrompt.includes('Source files with their definitions') && agentPrompt.includes('alpha'));
    check('ask prompt shows the sketch', askPrompt.includes('Source files with their definitions'));
    check('plan prompt renders the annotated tree, not the sketch', planPrompt.includes('<project_files>') && !planPrompt.includes('Source files with their definitions'));
    invalidatePromptContext();
    (globalThis as Record<string, unknown>).__tiermuxTestConfig = { symbolMap: false };
    const ctxOff = await gatherPromptContext(4_000);
    check('tiermux.agent.symbolMap=false → no sketch', ctxOff.symbolMap === undefined);
    check('…but the file map survives', !!ctxOff.fileMap);
    invalidatePromptContext();
    (globalThis as Record<string, unknown>).__tiermuxTestConfig = {};
    const lean = await gatherPromptContext(undefined);
    check('unbudgeted context (small model) adds no agent sketch', !composeSystemPrompt('agent', lean).includes('Source files with their definitions'));
    check('…and names no unmentioned non-source file', !composeSystemPrompt('agent', lean).includes('readme.md'));
  });

  console.log('\n— A repo past the 200-file tree cap keeps its agent sketch (review 2026-11-12: this repo has 336) —');
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-syms-big-'));
  fs.mkdirSync(path.join(big, 'src'));
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(big, 'src', `m${i}.ts`), `export function handler${i}() {}\n`);
  await runWithWorkspaceRoot(big, async () => {
    const map = await gatherProjectMap();
    check('symbols are still extracted above MAX_FILES_LISTED', map.symbols.size === 260, String(map.symbols.size));
    check('…and the budgeted sketch renders them', formatSymbolMap(map, 4_000).includes('handler'));
  });
  fs.rmSync(big, { recursive: true, force: true });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

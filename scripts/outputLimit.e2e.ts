// outputTokenLimit: catalog field parsing (bundled + remote row shape) and the router-side
// max_tokens math through defaultMaxOutputTokens — cap floors below the model's declared
// output limit while raising the flat 4096/8192 defaults elsewhere.
//
// Run:  npm run test:e2e:output-limit
import { Catalog } from '../src/catalog/catalog';
import { defaultMaxOutputTokens } from '../src/agent/executionProfile';
import type { CatalogModel } from '../src/shared/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

function model(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    platform: 'p', modelId: 'm', displayName: 'm',
    intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
    rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
    supportsTools: true, supportsVision: false, supportsReasoning: false,
    ...over,
  };
}

function main() {
  vscode.workspace.workspaceFolders = undefined;
  const repoRoot = path.resolve(__dirname, '..');
  const catalog = new Catalog(repoRoot);

  // ---- bundled curation: known-cap families carry outputTokenLimit ----
  const gem = catalog.all().filter((m) => m.modelId.includes('gemini-2.5'));
  ok('bundled gemini-2.5 models carry a 65536 cap', gem.length > 0 && gem.every((m) => m.outputTokenLimit === 65_536), `${gem.length} models`);
  const oss = catalog.all().filter((m) => m.modelId.includes('gpt-oss'));
  ok('bundled gpt-oss models carry a 32768 cap', oss.length > 0 && oss.every((m) => m.outputTokenLimit === 32_768), `${oss.length} models`);
  const capped = catalog.all().filter((m) => m.outputTokenLimit != null);
  const uncapped = catalog.all().filter((m) => m.outputTokenLimit == null);
  ok('uncapped models are null (router floor applies, no invented caps)', capped.length + uncapped.length === catalog.all().length && uncapped.length > 0);

  // ---- router math (same helper Router.routeSerial uses) ----
  ok('gemini-2.5-style reasoning cap: floor 16384 under a 65536 limit',
    defaultMaxOutputTokens(model({ supportsReasoning: true, outputTokenLimit: 65_536 })) === 16_384);
  ok('gpt-oss-style non-reasoning: floor 8192 under a 32768 limit',
    defaultMaxOutputTokens(model({ outputTokenLimit: 32_768 })) === 8_192);
  ok('a low real cap (2048) beats every floor',
    defaultMaxOutputTokens(model({ supportsReasoning: true, outputTokenLimit: 2_048 })) === 2_048);
  ok('null cap → raised floor (was 4096)', defaultMaxOutputTokens(model({ outputTokenLimit: null })) === 8_192);
  ok('missing field (legacy rows) → treated as unknown', defaultMaxOutputTokens(model({})) === 8_192);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

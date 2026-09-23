// Loads the Cline packages from the extension's CJS bundle. The @cline packages are
// ESM-only ("type": "module") and their exports maps carry no "require" condition, so
// require('@cline/agents') dies at exports resolution. Loading the dist ENTRY FILE directly
// bypasses the exports map, and Node's require(esm) runs the graph with real import.meta
// semantics — which @cline/llms' provider deps need at init. Requires Node ≥22.14
// (engines.vscode ≥1.101). The specifier is assembled at runtime so esbuild cannot resolve
// and inline the ESM graph into the CJS bundle (bundling crashes on import.meta.url).

export interface ClineRuntimeModule {
  AgentRuntime: typeof import('@cline/agents')['AgentRuntime'];
  createAgentRuntime?: typeof import('@cline/agents')['createAgentRuntime'];
}

export type ClineCoreModule = typeof import('@cline/core');
export type ClineSharedModule = typeof import('@cline/shared');

let cached: ClineRuntimeModule | undefined;
let cachedCore: ClineCoreModule | undefined;
let cachedShared: ClineSharedModule | undefined;

// '../' from dist/ (the bundle always lives one level below the package root).
function load<T>(pkg: string): T {
  const spec = '../node_modules/' + '@cline/' + pkg + '/dist/index.js';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(spec) as T;
}

export function loadClineRuntime(): ClineRuntimeModule {
  if (!cached) cached = load<ClineRuntimeModule>('agents');
  return cached;
}

/** @cline/core: the harness — builtin tools and executors, system prompt, rules/skills,
 *  compaction, MCP. */
export function loadClineCore(): ClineCoreModule {
  if (!cachedCore) cachedCore = load<ClineCoreModule>('core');
  return cachedCore;
}

/** @cline/shared: message formatting (the <user_input mode> wrapper, mode-switch notices). */
export function loadClineShared(): ClineSharedModule {
  if (!cachedShared) cachedShared = load<ClineSharedModule>('shared');
  return cachedShared;
}

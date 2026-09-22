// Loads the Cline agent runtime from the extension's CJS bundle. The @cline packages are
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

let cached: ClineRuntimeModule | undefined;

export function loadClineRuntime(): ClineRuntimeModule {
  if (cached) return cached;
  // '../' from dist/ (the bundle always lives one level below the package root).
  const spec = '../node_modules/' + '@cline/' + 'agents/dist/index.js';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  cached = require(spec) as ClineRuntimeModule;
  return cached;
}

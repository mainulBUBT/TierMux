// Ambient declaration for minimatch. The installed 3.x ships no bundled types and exports the
// function itself (`module.exports = minimatch`) — there is no named `minimatch` export at runtime.
declare module 'minimatch' {
  interface MinimatchOptions {
    dot?: boolean;
    nocase?: boolean;
    matchBase?: boolean;
    noglobstar?: boolean;
    [key: string]: unknown;
  }
  function minimatch(target: string, pattern: string, options?: MinimatchOptions): boolean;
  export = minimatch;
}

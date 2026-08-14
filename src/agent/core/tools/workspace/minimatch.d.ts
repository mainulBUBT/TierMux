// Ambient declaration for minimatch. The installed 3.x ships no bundled types; declaring just the
// surface we use (the callable form) keeps the glob tool self-contained without @types/minimatch.
declare module 'minimatch' {
  export interface MinimatchOptions {
    dot?: boolean;
    nocase?: boolean;
    matchBase?: boolean;
    noglobstar?: boolean;
    [key: string]: unknown;
  }
  export function minimatch(target: string, pattern: string, options?: MinimatchOptions): boolean;
  const _default: { Minimatch: new (pattern: string, options?: MinimatchOptions) => any };
  export default _default;
}

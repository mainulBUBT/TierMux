// Shared path-tokenisation utilities used by both the inverted index and the
// symbol index. Centralised here so the two indexes can't drift on what counts
// as a path token, a stop word, or a path-noise segment.

/** Path segments that describe WHERE code lives, not WHAT it does. Indexing
 *  these would let a query for "src" or "app" match every file in the workspace,
 *  drowning the pre-research in noise. Skip them. */
export const PATH_NOISE = new Set([
  'src', 'lib', 'app', 'test', 'tests', 'spec', 'specs', '__tests__',
  'dist', 'build', 'out', 'bin', 'inc', 'pkg',
]);

/** File extensions stripped from path segments before tokenising. */
export const PATH_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|php|py|go|rb|java|cs|cpp|c|rs|swift|kt)$/i;

/** English + code-keyword stop words. Indexed terms that match one of these are
 *  skipped. Includes common architectural-layer words ("service", "model", …)
 *  that would otherwise match every file in `app/Services/`, `app/Models/`, etc. */
export const PATH_STOP = new Set([
  // English
  'about','after','also','back','been','both','call','code','come','does','done','down',
  'each','even','file','files','find','from','give','goes','good','have','help','here',
  'into','just','keep','know','last','like','list','look','made','make','many','more',
  'most','move','much','must','name','need','next','only','open','over','page','part',
  'read','repo','rest','same','send','show','side','some','sure','take','tell','than',
  'that','them','then','they','this','time','true','used','uses','very','want','well',
  'went','were','what','when','will','with','word','work','your','gets','where','which',
  'there','these','those','their','codebase','project','function','user','users','data',
  'info','item','items','list','result','results','value','values','type','types',
  // Code keywords
  'const','class','return','export','import','default','interface','async','await',
  'void','null','true','false','undefined','string','number','boolean','object','array',
  'public','private','protected','static','readonly','abstract','override',
  // Architectural-layer words — common in BOTH code paths and natural-language
  // queries ("how does the service work?", "explain the model"). Without these,
  // a single search term matches every file in that layer.
  'service', 'services', 'controller', 'controllers', 'model', 'models',
  'helper', 'helpers', 'factory', 'factories', 'provider', 'providers',
  'component', 'components', 'repository', 'repositories', 'entity', 'entities',
  'middleware', 'manager', 'managers', 'handler', 'handlers', 'util', 'utils',
  'module', 'modules', 'plugin', 'plugins', 'config', 'configs', 'setting', 'settings',
]);

/** Tokenise a workspace-relative path into searchable tokens.
 *  `app/Services/MarketComparisonService.php`
 *    → ['app', 'services', 'marketcomparisonservice', 'market', 'comparison', 'service']
 *  Directory noise (PATH_NOISE) and stop words (PATH_STOP) are removed.
 *  Tokens are lowercased, ≥3 chars, deduplicated, original order preserved. */
export function tokenizePathSegments(relPath: string): string[] {
  const out = new Set<string>();
  const noExt = relPath.replace(PATH_EXT_RE, '');
  for (const seg of noExt.split(/[\\/]+/).filter(Boolean)) {
    const lower = seg.toLowerCase();
    if (PATH_NOISE.has(lower)) continue;
    if (lower.length >= 3 && !PATH_STOP.has(lower)) out.add(lower);
    for (const part of seg.split(/(?=[A-Z])|[_-]+/)) {
      const p = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (p.length >= 3 && !PATH_NOISE.has(p) && !PATH_STOP.has(p)) out.add(p);
    }
  }
  return [...out];
}

// Pre-agent research pipeline. Runs BEFORE the first model call and injects
// pre-researched context into the system prompt. This saves 2–3 agentic
// iterations (= 2–3 rate-limit slots on free LLMs like Groq/Cerebras) by
// answering the most likely first tool calls before the model even starts.
import type { WorkspaceTools } from './tools';
import type { CodebaseIndex } from '../index/codebaseIndex';
import type { InformationRoute } from '../router/informationRouter';
import { loadStructuralGraph } from '../context/structuralGraph';
import { getOrBuildSymbolIndex, searchSymbols, formatSymbolHits } from '../context/symbolIndex';
import { parseResearchFacts, compressToUnderstandingBlock, compactContextBlock, type ResearchFacts } from '../context/researchCompressor';

export interface ResearchResult {
  /** Full text: Understanding block + raw grep/semantic/hop sections. Used when confidence < 0.7. */
  text: string;
  /** Compact text: XML-style context tag only. Used when execution plan covers the file list. */
  compactText: string;
  facts: ResearchFacts;
  /** 0–1. What fraction of attempted research channels returned data (retrieval only). */
  coverageScore: number;
  /** 0–1. Quality-weighted average of match types (exact/fuzzy/stem). Separate from coverageScore. */
  semanticConfidence: number;
  /** Truth risk label: "low" = safe to answer, "medium" = answer with uncertainty, "high" = only confirmed facts. */
  riskLabel: 'low' | 'medium' | 'high';
}

const MAX_HOP_FILES = 6;
const MAX_HOP_CHARS = 1500;

const MAX_GREP_CHARS = 3000;
const MAX_SEARCH_CHARS = 2000;
const MAX_SEMANTIC_CHARS = 2000;
const MAX_DIAGNOSTICS_CHARS = 1500;
const MAX_REPOMAP_CHARS = 1000;
const MAX_WEB_CHARS = 2000;
// Per directly-referenced file: large enough to contain the relevant section without a
// second LLM readFile call. Smart excerpt finds the keyword first, so these chars are
// almost always the right section, not the file header.
const MAX_DIRECT_FILE_CHARS = 3000;

// Hard cap on the total pre-research block injected into the system prompt.
// Raised to 8k to accommodate large direct-file reads while keeping the overall
// prompt manageable. Direct reads are high-value (user pointed at the file explicitly),
// so the extra budget is well spent compared to noisy grep fallback content.
const MAX_TOTAL_RESEARCH_CHARS = 8000;

type GrepResult = { matches?: Array<{ path: string; hits: Array<{ line: number; text: string }> }> };
type WebResult = { results?: Array<{ title: string; url: string; snippet: string }> };

/** Match quality for a single research channel — drives semanticConfidence. */
export type MatchQuality = 'exact' | 'fuzzy' | 'stem' | 'web-partial' | 'web-minimal';

interface GrepSection {
  section: string;
  quality: 'exact' | 'stem';
}

/**
 * Validate that a stem-fallback grep result is actually related to the original term.
 * A stem match is considered relevant when at least one matched file path or hit text
 * contains a camelCase/PascalCase root word from the original term.
 *
 * Example: "calculateDeliveryFee" → roots: ["calculate", "delivery", "fee"]
 *   DeliveryService.php contains "delivery" → relevant ✓
 *   UserFactory.php only → irrelevant ✗ (stem "calculateDelive" matched by accident)
 */
function isStemMatchRelevant(originalTerm: string, matches: NonNullable<GrepResult['matches']>): boolean {
  // Split camelCase/PascalCase into root words ≥4 chars.
  const roots = originalTerm
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4);

  if (roots.length === 0) return true; // can't validate, allow

  return matches.some((m) =>
    roots.some(
      (root) =>
        m.path.toLowerCase().includes(root) ||
        m.hits.some((h) => h.text.toLowerCase().includes(root)),
    ),
  );
}

/**
 * Run a single grep with a stem fallback.
 * Returns quality info alongside the formatted section so callers can calibrate confidence.
 * Stem matches are validated for relevance — false positives are discarded.
 */
async function runGrep(
  tools: WorkspaceTools,
  term: string,
  maxChars: number,
  topN: number,
): Promise<GrepSection | null> {
  const candidates = [{ t: term, isStem: false }];
  if (term.length >= 7) {
    const stem = term.slice(0, Math.max(4, Math.ceil(term.length * 0.6)));
    if (stem !== term) candidates.push({ t: stem, isStem: true });
  }

  for (const { t, isStem } of candidates) {
    try {
      const raw = await tools.execute('grep', JSON.stringify({ pattern: t, regex: false }));
      if (typeof raw !== 'string') continue;
      const parsed = JSON.parse(raw) as GrepResult;
      if (!parsed.matches || parsed.matches.length === 0) continue;

      // Mismatch filter: reject stem results that don't share root words with the original term.
      if (isStem && !isStemMatchRelevant(term, parsed.matches)) continue;

      const lines = parsed.matches
        .slice(0, topN)
        .map((m) => `- **${m.path}**: ${m.hits.map((h) => `L${h.line}: \`${h.text.slice(0, 80)}\``).join(', ')}`);
      const fallbackTag = isStem ? ` _(stem: "${t}")_` : '';
      return {
        section: `### Grep results for "${term}"${fallbackTag}\n\n${lines.join('\n').slice(0, maxChars)}`,
        quality: isStem ? 'stem' : 'exact',
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Web search with a 3-tier fallback chain.
 * Partial Result Recovery Layer for web queries:
 *   Tier 1: full multi-term query ("calculateDeliveryFee DeliveryService")
 *   Tier 2: first term only ("calculateDeliveryFee")
 *   Tier 3: last term only (often a noun: "delivery")
 * Returns the first tier that yields results, labelled with which tier succeeded.
 * Never returns null if the webSearch tool is reachable — always surfaces something.
 */
async function webSearchWithFallback(
  tools: WorkspaceTools,
  searchTerms: string[],
  maxChars: number,
): Promise<{ section: string; coverage: 'full' | 'partial' | 'minimal' } | null> {
  const queries: Array<{ query: string; tier: 'full' | 'partial' | 'minimal' }> = [
    { query: searchTerms.join(' '), tier: 'full' },
    { query: searchTerms[0], tier: 'partial' },
    ...(searchTerms.length > 1 ? [{ query: searchTerms[searchTerms.length - 1], tier: 'minimal' as const }] : []),
  ];

  const tried = new Set<string>();
  for (const { query, tier } of queries) {
    const q = query.trim();
    if (!q || tried.has(q)) continue;
    tried.add(q);
    try {
      const raw = await tools.execute('webSearch', JSON.stringify({ query: q }));
      if (typeof raw !== 'string') continue;
      const parsed = JSON.parse(raw) as WebResult;
      if (!parsed.results || parsed.results.length === 0) continue;
      const lines = parsed.results
        .slice(0, 3)
        .map((r) => `**${r.title}** (${r.url})\n${r.snippet}`);
      const tierNote = tier !== 'full' ? ` _(fallback query: "${q}")_` : '';
      return {
        section: `### Web results${tierNote}\n\n${lines.join('\n\n').slice(0, maxChars)}`,
        coverage: tier,
      };
    } catch {
      continue;
    }
  }
  return null;
}

const MAX_EXCERPT_CHARS = 700;   // per file
const MAX_EXCERPT_FILES = 2;     // read at most 2 files per grep result
const EXCERPT_WINDOW = 35;       // lines of context around each match

/**
 * After grep locates file+line refs, read the actual file content around each match.
 * This eliminates 2-4 model round trips: instead of the model calling readFile() after
 * seeing grep results, the content is already in the pre-research block.
 *
 * Only fires for the primary grep result to keep latency bounded.
 * Uses the file cache in WorkspaceTools — no network, just disk reads.
 */
async function readGrepExcerpts(
  tools: WorkspaceTools,
  grepSection: string,
): Promise<string | null> {
  // Parse "**path/to/file.php**: L42:" refs from the formatted grep section.
  const refs: Array<{ path: string; line: number }> = [];
  for (const m of grepSection.matchAll(/\*\*([\w./\\-]+\.[a-zA-Z]{1,5})\*\*[^L]*L(\d+)/g)) {
    refs.push({ path: m[1], line: parseInt(m[2], 10) });
    if (refs.length >= MAX_EXCERPT_FILES) break;
  }
  if (refs.length === 0) return null;

  const excerpts: string[] = [];
  for (const { path, line } of refs) {
    try {
      const raw = await tools.execute('readFile', JSON.stringify({ path }));
      if (typeof raw !== 'string') continue;
      const fileLines = raw.split('\n');
      const start = Math.max(0, line - 6);
      const end = Math.min(fileLines.length, line + EXCERPT_WINDOW);
      const excerpt = fileLines.slice(start, end).join('\n').slice(0, MAX_EXCERPT_CHARS);
      if (excerpt.trim()) {
        excerpts.push(`**${path}** (L${start + 1}–${end}):\n\`\`\`\n${excerpt}\n\`\`\``);
      }
    } catch { continue; }
  }

  return excerpts.length
    ? `### File excerpts (from grep hits)\n\n${excerpts.join('\n\n')}`
    : null;
}

/**
 * Run lightweight pre-research based on the classified information route.
 * Returns a markdown string to append to the system prompt, or '' if nothing useful was found.
 *
 * All tool calls go through `tools.execute()` so they benefit from the file/search caches.
 * Errors in any sub-step are silently swallowed — pre-research is best-effort.
 *
 * Semantic search + all greps + diagnostics run in parallel to minimise wall-clock latency.
 */
export async function runResearchPipeline(
  route: InformationRoute,
  tools: WorkspaceTools,
  index: CodebaseIndex | undefined,
): Promise<ResearchResult> {
  const sections: string[] = [];

  const wantsGrep = route.codeSearch && route.searchTerms.length > 0;
  // Skip the second grep when the user explicitly referenced files — those direct reads
  // already contain the relevant context, so a second grep just adds noise and latency.
  const hasDirectFiles = (route.directFiles ?? []).length > 0;
  const wantsSecondGrep = wantsGrep && !hasDirectFiles && route.searchTerms.length > 1 && route.confidence < 0.7;

  interface SymbolSection { section: string; quality: 'exact' | 'fuzzy' }

  // ---- Fan-out: semantic search + grep(s) + direct file reads + diagnostics all in parallel ----
  const [semanticSection, grepResult0, grepResult1, symbolResult, webResult, diagSection, directSection] = await Promise.all([
    // Semantic search (embedding-based, highest quality signal)
    (async (): Promise<string | null> => {
      if (!wantsGrep || !index?.isEnabled() || !index.hasIndex()) return null;
      try {
        const query = route.searchTerms.join(' ');
        const results = await index.search(query, 5);
        if (results.length === 0) return null;
        const block = results
          .map((r) => '```\n' + `// ${r.file}:${r.startLine}-${r.endLine}\n` + r.text.replace(/^\/\/.*\n/, '').slice(0, 600) + '\n```')
          .join('\n\n');
        return `### Semantic matches for "${query}"\n\n${block.slice(0, MAX_SEMANTIC_CHARS)}`;
      } catch {
        return null;
      }
    })(),

    // Primary grep — returns quality info; stem matches are mismatch-filtered
    wantsGrep ? runGrep(tools, route.searchTerms[0], MAX_GREP_CHARS, 8) : Promise.resolve(null),

    // Secondary grep term (low-confidence: cast wider net)
    wantsSecondGrep ? runGrep(tools, route.searchTerms[1], MAX_SEARCH_CHARS, 5) : Promise.resolve(null),

    // Symbol index lookup — O(1) answer to "where is X defined?" questions.
    // Tracks exact vs fuzzy match quality separately.
    (async (): Promise<SymbolSection | null> => {
      if (!wantsGrep || route.searchTerms.length === 0) return null;
      try {
        const graph = await loadStructuralGraph();
        if (!graph || graph.files.length === 0) return null;
        const idx = getOrBuildSymbolIndex(graph);
        const hits: Array<{ name: string; file: string; line: number; kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'let' | 'var' | 'default' | 'enum' }> = [];
        for (const term of route.searchTerms) {
          // Exact first, then fuzzy. Stop when we have 8 hits total.
          const exact = (idx.get(term) ?? []).map((e) => ({ name: term, ...e }));
          const fuzzy = exact.length === 0 ? searchSymbols(idx, term, 4) : [];
          hits.push(...exact, ...fuzzy);
          if (hits.length >= 8) break;
        }
        if (hits.length === 0) return null;
        // Track exact vs fuzzy — fuzzy matches carry less confidence.
        const hasExact = route.searchTerms.some((term) => !!idx.get(term)?.length);
        return { section: formatSymbolHits(hits.slice(0, 8)), quality: hasExact ? 'exact' : 'fuzzy' };
      } catch {
        return null;
      }
    })(),

    // Web search — 3-tier fallback, quality tracked per tier.
    (async (): Promise<ReturnType<typeof webSearchWithFallback> extends Promise<infer T> ? T : never> => {
      if (!route.webSearch || route.searchTerms.length === 0) return null;
      return webSearchWithFallback(tools, route.searchTerms, MAX_WEB_CHARS);
    })(),

    // Diagnostics for debug tasks
    (async (): Promise<string | null> => {
      if (!route.needsDebug) return null;
      try {
        const raw = await tools.execute('getDiagnostics', '{}');
        if (typeof raw !== 'string') return null;
        const parsed = JSON.parse(raw) as { files?: Array<{ path: string; diagnostics: Array<{ severity: string; line: number; message: string }> }> };
        if (!parsed.files || parsed.files.length === 0) return null;
        const errors = parsed.files
          .filter((f) => f.diagnostics.some((d) => d.severity === 'Error'))
          .slice(0, 5)
          .map((f) => `**${f.path}**: ${f.diagnostics.filter((d) => d.severity === 'Error').slice(0, 3).map((d) => `L${d.line} ${d.message}`).join('; ')}`);
        if (errors.length === 0) return null;
        return `### Current diagnostics (errors)\n\n${errors.join('\n').slice(0, MAX_DIAGNOSTICS_CHARS)}`;
      } catch {
        return null;
      }
    })(),

    // Direct file reads for explicitly-mentioned paths (@path or bare path/to/file.ext).
    // Uses a smart keyword-anchored excerpt: finds the line in the file that best matches
    // the user's query terms, then returns a window around it. This means the model gets
    // the RELEVANT section (e.g. the map JS block, not the HTML header) without calling
    // readFile in its loop. Capped at MAX_DIRECT_FILE_CHARS per file — large enough to
    // be self-contained, small enough not to overflow free-model context windows.
    (async (): Promise<string | null> => {
      const files = (route.directFiles ?? []).slice(0, 2);
      if (files.length === 0) return null;
      const excerpts: string[] = [];
      for (const path of files) {
        try {
          const raw = await tools.execute('readFile', JSON.stringify({ path }));
          if (typeof raw !== 'string' || !raw.trim()) continue;
          const lines = raw.split('\n');
          // Find the best anchor line: the one that contains the most search terms.
          const keywords = route.searchTerms.map((t) => t.toLowerCase());
          let bestLine = 0;
          let bestScore = 0;
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i].toLowerCase();
            const score = keywords.filter((k) => l.includes(k)).length;
            if (score > bestScore) { bestScore = score; bestLine = i; }
          }
          // Window: 40 lines before the anchor + 60 after (code that causes a bug is
          // usually below the symptom line, so bias the window downward).
          const start = Math.max(0, bestLine - 40);
          const end = Math.min(lines.length, bestLine + 60);
          const excerpt = lines.slice(start, end).join('\n').slice(0, MAX_DIRECT_FILE_CHARS);
          const note = bestScore > 0
            ? ` (lines ${start + 1}–${end}, anchored on "${route.searchTerms[0]}")`
            : ` (lines ${start + 1}–${end})`;
          excerpts.push(`**${path}**${note}:\n\`\`\`\n${excerpt}\n\`\`\``);
        } catch { continue; }
      }
      return excerpts.length
        ? `### Directly referenced files\n\n${excerpts.join('\n\n')}`
        : null;
    })(),
  ]);

  // ---- Unwrap typed results ----
  const grepSection0 = grepResult0?.section ?? null;
  const grepSection1 = grepResult1?.section ?? null;
  const symbolSection = symbolResult?.section ?? null;
  const webSection = webResult?.section ?? null;

  // ---- Semantic confidence: separate from coverage ----
  // retrievalCoverage = how much data we got
  // semanticConfidence = how correct/relevant that data is likely to be
  //
  // Quality signals:
  //   exact symbol/grep match  → +high
  //   fuzzy symbol match       → +medium
  //   stem grep match          → +low  (validated but semantically weaker)
  //   semantic embedding match → +high (it's a semantic match by definition)
  //   web full-query match     → +medium
  //   web partial/minimal      → +low
  const matchQualities: MatchQuality[] = [
    ...(directSection ? ['exact' as MatchQuality] : []),  // direct read = highest confidence
    ...(symbolResult ? [symbolResult.quality] : []),
    ...(grepResult0 ? [grepResult0.quality as MatchQuality] : []),
    ...(grepResult1 ? [grepResult1.quality as MatchQuality] : []),
    ...(semanticSection ? ['exact' as MatchQuality] : []),
    ...(webResult ? [webResult.coverage === 'full' ? 'exact' as MatchQuality : webResult.coverage === 'partial' ? 'fuzzy' as MatchQuality : 'stem' as MatchQuality] : []),
  ];

  const QUALITY_SCORE: Record<MatchQuality, number> = { exact: 1.0, fuzzy: 0.6, stem: 0.3, 'web-partial': 0.5, 'web-minimal': 0.25 };
  const semanticConfidence = matchQualities.length === 0
    ? 0
    : matchQualities.reduce((sum, q) => sum + QUALITY_SCORE[q], 0) / matchQualities.length;

  // Risk label: truth calibration, not just retrieval coverage.
  //   LOW     → safe to answer directly
  //   MEDIUM  → answer with stated uncertainty
  //   HIGH    → only answer confirmed facts; label unknowns explicitly
  const riskLabel: 'low' | 'medium' | 'high' =
    semanticConfidence >= 0.7 ? 'low' :
    semanticConfidence >= 0.4 ? 'medium' : 'high';

  // ---- Coverage score (retrieval only — kept separate from semantic confidence) ----
  const wantsDirectRead = (route.directFiles ?? []).length > 0;
  const channels: Array<{ name: string; attempted: boolean; succeeded: boolean }> = [
    { name: 'symbol', attempted: wantsGrep, succeeded: !!symbolSection },
    { name: 'semantic', attempted: wantsGrep && (!!index?.isEnabled() && !!index.hasIndex()), succeeded: !!semanticSection },
    { name: 'grep', attempted: wantsGrep, succeeded: !!grepSection0 },
    { name: 'grep2', attempted: wantsSecondGrep, succeeded: !!grepSection1 },
    { name: 'web', attempted: route.webSearch && route.searchTerms.length > 0, succeeded: !!webSection },
    { name: 'diag', attempted: route.needsDebug, succeeded: !!diagSection },
    { name: 'direct', attempted: wantsDirectRead, succeeded: !!directSection },
  ];
  const attempted = channels.filter((c) => c.attempted);
  const succeeded = attempted.filter((c) => c.succeeded);
  const coverageScore = attempted.length > 0 ? succeeded.length / attempted.length : 1.0;
  const coveragePct = Math.round(coverageScore * 100);
  const channelDetail = attempted.map((c) => `${c.name}${c.succeeded ? '✓' : '✗'}`).join(' ');

  // ---- Auto-read top grep hits: extract actual file content around matched lines ----
  // This replaces 2-4 model readFile() round trips with pre-fetched excerpts, giving
  // the model the business logic it needs before it makes a single tool call.
  // Runs AFTER the parallel phase (depends on grep results) but is fast — hits file cache.
  let excerptSection: string | null = null;
  if (grepSection0 && route.codeSearch) {
    excerptSection = await readGrepExcerpts(tools, grepSection0).catch(() => null);
  }

  // Direct file reads go first — highest signal, zero inference needed.
  if (directSection) sections.push(directSection);
  // Symbol index — most precise structural signal (exact file+line).
  if (symbolSection) sections.push(symbolSection);
  if (semanticSection) sections.push(semanticSection);
  if (grepSection0) sections.push(grepSection0);
  if (excerptSection) sections.push(excerptSection);
  if (grepSection1) sections.push(grepSection1);
  if (diagSection) sections.push(diagSection);
  if (webSection) sections.push(webSection);

  // ---- Multi-hop: follow import edges 1 level from files found in grep/symbol results ----
  // Example: grep finds DeliveryController.php → its imports show DeliveryService, DeliveryRepository
  // Model sees the full chain without extra tool calls: Controller → Service → Repository → Config
  if (route.codeSearch && sections.length > 0) {
    try {
      const graph = await loadStructuralGraph();
      if (graph && graph.imports.length > 0) {
        // Collect files already found in grep/symbol sections.
        const foundFiles = new Set<string>();
        const filePattern = /\*\*([\w./\\-]+\.[a-zA-Z]{1,5})\*\*/g;
        for (const sec of sections) {
          for (const m of sec.matchAll(filePattern)) foundFiles.add(m[1]);
        }
        // Also collect from symbol section (format: "→ path/to/file.ts:42")
        const arrowPattern = /→\s+([\w./\\-]+\.[a-zA-Z]{1,5}):\d+/g;
        for (const sec of sections) {
          for (const m of sec.matchAll(arrowPattern)) foundFiles.add(m[1]);
        }

        if (foundFiles.size > 0) {
          const hopFiles = new Set<string>();
          for (const src of foundFiles) {
            for (const edge of graph.imports) {
              if (edge.from === src && !foundFiles.has(edge.to)) {
                hopFiles.add(edge.to);
                if (hopFiles.size >= MAX_HOP_FILES) break;
              }
            }
            if (hopFiles.size >= MAX_HOP_FILES) break;
          }

          if (hopFiles.size > 0) {
            const lines = [...foundFiles].slice(0, 4).map((f) => {
              const hops = [...hopFiles].filter((h) =>
                graph.imports.some((e) => e.from === f && e.to === h));
              return hops.length
                ? `- \`${f}\` → ${hops.map((h) => `\`${h}\``).join(', ')}`
                : null;
            }).filter(Boolean);

            if (lines.length > 0) {
              sections.push(`### Import chain (1 hop)\n\n${lines.join('\n').slice(0, MAX_HOP_CHARS)}`);
            }
          }
        }
      }
    } catch { /* best-effort */ }
  }

  // ---- RepoMap: only when no index AND nothing found yet (sequential — depends on sections) ----
  if (route.codeSearch && !index?.hasIndex() && sections.length === 0) {
    try {
      const raw = await tools.execute('repoMap', '{}');
      if (typeof raw === 'string') {
        const parsed = JSON.parse(raw) as { totalFiles?: number; directories?: string[]; keyFiles?: string[] };
        const lines = [
          `Files: ${parsed.totalFiles ?? '?'}`,
          parsed.directories?.length ? `Dirs: ${parsed.directories.slice(0, 12).join(', ')}` : '',
          parsed.keyFiles?.length ? `Key files: ${parsed.keyFiles.slice(0, 10).join(', ')}` : '',
        ].filter(Boolean);
        if (lines.length) sections.push(`### Repo structure\n\n${lines.join('\n').slice(0, MAX_REPOMAP_CHARS)}`);
      }
    } catch { /* best-effort */ }
  }

  const emptyFacts: ResearchFacts = { symbols: [], fileHits: [], importEdges: [], webTitles: [], diagErrors: 0, searchTerms: route.searchTerms };
  if (!sections.length) return { text: '', compactText: '', facts: emptyFacts, coverageScore: 0, semanticConfidence: 0, riskLabel: 'high' };

  // ---- Context Compression: synthesise a structured understanding block ----
  const facts = parseResearchFacts(sections, route.searchTerms);

  // Compact path: XML-style tag (~25 tokens). Used when execution plan is high-confidence.
  const compactText = compactContextBlock(facts);

  // Truth calibration tag — compact, machine-readable.
  // Two separate scores: retrieval (how much data) vs semantic (how correct).
  // The model MUST read both before deciding how confidently to answer.
  const semPct = Math.round(semanticConfidence * 100);
  const calibrationTag = `<truth-calibration retrieval="${coveragePct}%" semantic="${semPct}%" risk="${riskLabel}" channels="${channelDetail}" />`;

  // Risk-calibrated hint: drives model behavior, not just "answer anyway."
  let coverageHint = '';
  const failed = attempted.filter((c) => !c.succeeded).map((c) => c.name).join(', ') || 'none';
  if (riskLabel === 'high') {
    coverageHint = `\n\n<!-- ⚠️ HIGH truth risk (semantic confidence ${semPct}%). ` +
      `Matches were weak or based on stem/fuzzy. Failed channels: ${failed}. ` +
      `ONLY answer what is directly confirmed by the data above. ` +
      `EXPLICITLY label any inferred or uncertain parts as "unverified". ` +
      `Do NOT fill gaps with general knowledge — prefer asking the user. -->`;
  } else if (riskLabel === 'medium') {
    coverageHint = `\n\n<!-- ⚡ MEDIUM truth risk (semantic confidence ${semPct}%). ` +
      `Some matches were fuzzy or from fallback queries. Failed: ${failed}. ` +
      `Answer with calibrated uncertainty. State what is confirmed vs inferred. -->`;
  }

  // Full path: Understanding block + raw sections (~400-900 tokens). Used for low-confidence.
  const understanding = compressToUnderstandingBlock(facts);
  const header = understanding
    ? `${calibrationTag}${coverageHint}\n\n${understanding}\n\n---\n\n## Research details (use as reference)`
    : `${calibrationTag}${coverageHint}\n\n## Pre-research (starting hints — keep investigating with your tools for a complete answer)`;

  // Cap total block size: trim raw sections from the end (least precise first) until we're
  // under the budget. The header + understanding block are kept intact — they're already
  // compressed. This prevents a 12k+ char research block overwhelming free model context windows.
  const rawSections = sections.join('\n\n');
  const full = `${header}\n\n${rawSections}`;
  const trimmed = full.length > MAX_TOTAL_RESEARCH_CHARS
    ? full.slice(0, MAX_TOTAL_RESEARCH_CHARS) + '\n\n<!-- research truncated to stay within context budget -->'
    : full;

  return { text: trimmed, compactText, facts, coverageScore, semanticConfidence, riskLabel };
}

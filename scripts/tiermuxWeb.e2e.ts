/**
 * TierMux web engine — standalone verification (bundled + run under node, no VS Code).
 *
 * Mirrors the scripts/*.e2e.ts convention (esbuild → CJS → node). Two sections:
 *
 *   1. Offline (deterministic, always runs) — pure functions on fixture data:
 *        - search-engine HTML parsing (DDG, Yahoo)
 *        - result-URL normalization (redirect unwrap + UTM strip)
 *        - search dedup + ranking across engines
 *        - llms.txt routing (routes on relevant query, stays put on irrelevant)
 *        - HTML main-content extraction (jsdom: picks <article>, strips nav)
 *
 *   2. Live (network, opt out via SKIP_LIVE=1) — real calls against
 *      deep_search APIs + one webSearch + one fetchUrl. Live failures never
 *      fail the suite (printed as warnings) so CI/offline runs stay green.
 *
 * Run:  npm run test:e2e:f reeweb
 */
import { parseDdgHtml, parseYahooHtml } from '../src/agent/core/tools/network/tiermuxWeb/search-html';
import { normalizeSearchResultUrl, normalizeComparableUrl } from '../src/agent/core/tools/network/tiermuxWeb/url';
import {
  normalizeEngineResults,
  mergeSearchResults,
  scoreSearchResult,
} from '../src/agent/core/tools/network/tiermuxWeb/scoring';
import { resolveLlmsRoute } from '../src/agent/core/tools/network/tiermuxWeb/routing';
import type { LlmsDocument } from '../src/agent/core/tools/network/tiermuxWeb/llms';
import { extractMainContentFromHtml } from '../src/agent/core/tools/network/tiermuxWeb/fetcher/http';
import { collectWebSearchResults } from '../src/agent/core/tools/network/tiermuxWeb/search';
import { deepSearch } from '../src/agent/core/tools/network/tiermuxWeb/deep-search';
import { browseUrl } from '../src/agent/core/tools/network/tiermuxWeb/browse';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function warn(msg: string): void {
  console.log(`  · ${msg}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────

const DDG_HTML = `
<html><body>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Flearn&rut=abc">React Quick Start</a></h2>
  <a class="result__snippet" >Learn how to build a React app from scratch.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvuejs.org%2Fguide%2F">Vue.js Guide</a></h2>
  <a class="result__snippet">The progressive JavaScript framework.</a>
</div>
</body></html>`;

const YAHOO_HTML = `
<html><body>
<div class="compTitle">
  <a href="https://r.search.yahoo.com/...?RU=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FJavaScript">
    <h3>JavaScript | MDN</h3>
  </a>
</div>
<div class="compText"><p>Comprehensive JavaScript reference.</p></div>
</body></html>`;

// Page with an <article> (main) plus nav/footer noise that must be stripped.
const ARTICLE_HTML = `
<html><head><title>Real Article</title></head><body>
  <nav>Home About Contact Sign in</nav>
  <article>
    <h1>How fetchers work</h1>
    <p>The fetcher chain tries fast layers first: markdown, GitHub raw, RSS, then HTTP with jsdom.
       Each layer can short-circuit the chain, so most pages never need the heavier fallbacks.
       When a layer returns low-quality or empty content, the chain advances to the next one.</p>
    <p>Only when every fast layer fails does it give up entirely and report that the page could
       not be read as static HTML.</p>
  </article>
  <footer>© 2024 BigCo. Cookie settings. Sign up for our newsletter.</footer>
  <script>tracking();</script>
</body></html>`;

// ── 1. offline: search-engine HTML parsing ─────────────────────────────────

console.log('\n[offline] search-engine parsing');
{
  const ddg = parseDdgHtml(DDG_HTML);
  assert(ddg.length === 2, 'DDG parser extracts 2 results');
  assert(ddg[0].title.includes('React'), 'DDG first result title parsed');
  assert(ddg[0].url === 'https://react.dev/learn', 'DDG parser unwraps uddg to the canonical url');

  const yahoo = parseYahooHtml(YAHOO_HTML);
  assert(yahoo.length >= 1, 'Yahoo parser extracts >=1 result');
  if (yahoo.length) {
    assert(yahoo[0].title.includes('MDN') || yahoo[0].title.includes('JavaScript'), 'Yahoo result title parsed');
  }
}

// ── 2. offline: URL normalization (redirect unwrap + UTM strip) ─────────────

console.log('\n[offline] url normalization');
{
  const unwrapped = normalizeSearchResultUrl(
    'https://duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Flearn&rut=abc',
  );
  assert(unwrapped === 'https://react.dev/learn', 'DDG uddg redirect unwrapped to canonical url');

  const yahooUnwrapped = normalizeSearchResultUrl(
    'https://r.search.yahoo.com/ar?RU=https%3A%2F%2Fmdn.example%2Fx',
  );
  assert(yahooUnwrapped.startsWith('https://mdn.example'), 'Yahoo RU redirect unwrapped');

  const cleaned = normalizeSearchResultUrl('https://example.com/page?utm_source=tw&utm_medium=soc&id=42');
  assert(!cleaned.includes('utm_') && cleaned.includes('id=42'), 'UTM params stripped, non-tracking param kept');
}

// ── 3. offline: search dedup + ranking across engines ───────────────────────

console.log('\n[offline] dedup + ranking');
{
  // Same canonical URL surfaced by two engines must merge into one result.
  const a = normalizeEngineResults('react hooks', [
    { title: 'React Hooks', url: 'https://react.dev/reference/react', snippet: 'useEffect, useState' },
  ], 'duckduckgo')[0];
  const b = normalizeEngineResults('react hooks', [
    { title: 'Hooks Reference', url: 'https://react.dev/reference/react', snippet: 'API reference for hooks' },
  ], 'yahoo')[0];
  assert(!!a && !!b, 'normalized results produced for both engines');
  const merged = mergeSearchResults(a, b);
  assert(!!merged, 'mergeSearchResults accepts a cross-engine duplicate');
  // A multi-engine-hit result should outrank a single-engine hit for the same query.
  const single = scoreSearchResult('react hooks', a, undefined, 18).score;
  assert(merged.score >= single, 'merged (two-engine) result scores >= single-engine result');

  // Domain filter boosts matching host.
  const onDomain = scoreSearchResult('api', {
    title: 'API', url: 'https://react.dev/api', snippet: 'x', host: 'react.dev', engine: 'yahoo',
  }, 'react.dev', 18).score;
  const offDomain = scoreSearchResult('api', {
    title: 'API', url: 'https://example.com/api', snippet: 'x', host: 'example.com', engine: 'yahoo',
  }, 'react.dev', 18).score;
  assert(onDomain > offDomain, 'domain filter boosts the matching host');
}

// ── 4. offline: llms.txt routing ────────────────────────────────────────────

console.log('\n[offline] llms.txt routing');
{
  const llms: LlmsDocument = {
    sourceUrl: 'https://example.com/llms.txt',
    title: 'Example Docs',
    introNotes: [],
    sections: [
      {
        title: 'Docs',
        optional: false,
        notes: [],
        links: [
          { title: 'Getting started', url: 'https://example.com/docs/start' },
          { title: 'Authentication guide', url: 'https://example.com/docs/auth', note: 'oauth' },
        ],
      },
    ],
  };

  const routed = resolveLlmsRoute('https://example.com', llms, 'how do I authenticate with oauth');
  assert(routed.routed, 'routes to the auth page on a relevant query');
  assert(routed.targetUrl.includes('/docs/auth'), 'target url is the auth link');

  const unrelated = resolveLlmsRoute('https://example.com', llms, 'weather forecast tomorrow');
  assert(!unrelated.routed, 'does NOT route on an irrelevant query (queryHits gate)');
}

// ── 5. offline: HTML main-content extraction (jsdom) ────────────────────────
// ── 6. live (network) — skipped under SKIP_LIVE=1, never fails the suite ────
// These two sections need await; CJS output forbids top-level await, so the
// whole async tail runs inside main().

async function main(): Promise<void> {
  console.log('\n[offline] html extraction (jsdom)');
  {
    const extracted = await extractMainContentFromHtml(ARTICLE_HTML);
    assert(!!extracted, 'extractor returns content for valid article html');
    if (extracted) {
      assert(extracted.title === 'Real Article', 'extracted <title>');
      assert(extracted.text.includes('fetcher chain'), 'extracted main <article> text');
      assert(!extracted.text.includes('Cookie settings'), 'nav/footer noise stripped');
      assert(!extracted.text.includes('tracking('), 'script content stripped');
    }
  }

  if (process.env.SKIP_LIVE === '1') {
    console.log('\n[live] skipped (SKIP_LIVE=1)');
  } else {
    console.log('\n[live] network calls (warnings only — do not fail suite)');
    try {
      const items = await deepSearch('react', ['npm', 'mdn'], 3);
      if (items.length) warn(`deepSearch returned ${items.length} item(s) across npm/mdn`);
      else warn('deepSearch returned 0 items (network/API may be rate-limited)');
    } catch (e) {
      warn(`deepSearch errored (non-fatal): ${(e as Error).message}`);
    }
    try {
      const { results, attempts } = await collectWebSearchResults('typescript generics', 'auto', undefined, 3);
      warn(`webSearch: ${results.length} result(s); engines=${attempts.map((a) => a.engine).join(',')}`);
    } catch (e) {
      warn(`webSearch errored (non-fatal): ${(e as Error).message}`);
    }
    try {
      const page = await browseUrl({ url: 'https://react.dev/learn', maxContentLength: 1500 });
      warn(`fetchUrl(browse): title="${(page.title || '').slice(0, 40)}", ${page.content.length} chars via ${page.contentSource}`);
    } catch (e) {
      warn(`fetchUrl(browse) errored (non-fatal): ${(e as Error).message}`);
    }
  }

  // ── result ──────────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed (offline assertions only count toward failure)`);
  if (failed > 0) process.exit(1);
}

void main();


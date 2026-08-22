#!/usr/bin/env node
/**
 * Validate the model catalog against LIVE REMOTE SOURCES — never against hardcoded expectations.
 *
 * Why this exists: on 2026-08-20 the shipped catalog was carrying 8 models that no longer exist
 * anywhere — 4 GitHub Models entries (the API returns HTTP 410, the product was retired
 * 2026-07-30), 3 Mistral models past their published retirement dates, and an NVIDIA 405B that is
 * absent from NVIDIA's own live catalog. None of it was detectable, because nothing in the repo
 * ever asked a provider anything. Hand-fixing `media/catalog.json` is also not enough: the worker
 * is the real source, and it still serves those same dead Mistral/NVIDIA rows, so a single
 * `tiermux.refreshModels` puts them straight back.
 *
 * So: this checks BOTH catalogs (bundled + worker) against whatever each provider actually
 * publishes, plus internal consistency rules that need no network at all.
 *
 * Only providers with a PUBLIC, keyless models endpoint can be verified remotely. That is a small
 * set (see REMOTE_SOURCES) — Groq, Cerebras, Mistral, Google, Cohere all require a key and/or
 * publish no pricing, so their rows are checked structurally and flagged as unverifiable rather
 * than silently assumed correct. Claiming to validate what we cannot reach would be worse than
 * admitting the gap.
 *
 * Usage:
 *   node scripts/validate-catalog.mjs              # bundled + worker + remote
 *   node scripts/validate-catalog.mjs --offline    # skip all network, structural checks only
 *   node scripts/validate-catalog.mjs --json       # machine-readable report
 * Exit code 1 if any ERROR-level finding is present (warnings alone still exit 0).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RETIRED_MODEL_KEYS } from './retiredModels.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_URL = 'https://tiermux.mainulislam3057.workers.dev/';
const TIMEOUT_MS = 25_000;

const argv = new Set(process.argv.slice(2));
const OFFLINE = argv.has('--offline');
const AS_JSON = argv.has('--json');

// Deduped: the same model is usually present in BOTH the bundled catalog and the worker, so the
// remote checks would otherwise report every upstream removal twice.
const findings = [];
const seenFindings = new Set();
const add = (level, scope, message) => {
  const key = `${level}|${scope}|${message}`;
  if (seenFindings.has(key)) return;
  seenFindings.add(key);
  findings.push({ level, scope, message });
};

async function getJson(url, label) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'tiermux-catalog-validator' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, body: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Providers that publish a models list without an API key.
 *
 * `ids` extracts the set of live model ids. `priceOf` returns [inputPerM, outputPerM] or null when
 * the provider publishes no pricing — null means "existence checkable, free-ness not", which the
 * report distinguishes rather than glossing over.
 */
/*
 * `priceIsFreeness` is the subtle bit. A published price of $0 always proves free. A price ABOVE
 * zero proves nothing on its own: SambaNova charges $0.22/1M for gpt-oss-120b AND offers it on a
 * 20 RPM / 20 RPD free tier, so its API returns the PAID rate for a model that is genuinely free
 * to use. Only where the provider's free offering IS the zero-priced listing (OpenRouter's `:free`
 * variants, Hugging Face routing) can a non-zero price be read as "this is not free".
 */
const REMOTE_SOURCES = {
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/models',
    ids: (b) => new Set((b.data ?? []).map((m) => m.id)),
    priceOf: () => null, // NVIDIA publishes no pricing in the API
    priceIsFreeness: false,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    ids: (b) => new Set((b.data ?? []).map((m) => m.id)),
    // pricing.prompt/completion are STRINGS in USD per TOKEN — multiply to per-million.
    priceOf: (b, id) => {
      const m = (b.data ?? []).find((x) => x.id === id);
      if (!m?.pricing) return null;
      return [Number(m.pricing.prompt) * 1e6, Number(m.pricing.completion) * 1e6];
    },
    priceIsFreeness: true,
    // OpenRouter publishes a retirement date on some models — free promos especially. Catching
    // it here means a model is dropped BEFORE it starts failing, instead of after users hit it.
    expiryOf: (b, id) => (b.data ?? []).find((x) => x.id === id)?.expiration_date ?? null,
  },
  huggingface: {
    url: 'https://router.huggingface.co/v1/models',
    ids: (b) => new Set((b.data ?? []).map((m) => m.id)),
    priceOf: (b, id) => {
      const m = (b.data ?? []).find((x) => x.id === id);
      const p = m?.providers?.[0]?.pricing;
      return p ? [Number(p.input), Number(p.output)] : null;
    },
    priceIsFreeness: true,
  },
  sambanova: {
    url: 'https://api.sambanova.ai/v1/models',
    ids: (b) => new Set((b.data ?? []).map((m) => m.id)),
    priceOf: (b, id) => {
      const m = (b.data ?? []).find((x) => x.id === id);
      if (!m?.pricing) return null;
      return [Number(m.pricing.prompt) * 1e6, Number(m.pricing.completion) * 1e6];
    },
    // SambaNova runs a separate free tier (20 RPM / 20 RPD); the API reports the paid rate.
    priceIsFreeness: false,
  },
};

/** Endpoints that must NOT be alive — a retired product resurfacing is worth an explicit check. */
const RETIRED_ENDPOINTS = {
  github: 'https://models.github.ai/catalog/models',
};

/** Structural rules that need no network. Each caught a real defect in the shipped catalog. */
function structuralChecks(models, scope) {
  for (const m of models) {
    const id = `${m.platform}/${m.modelId}`;
    // 0 is never a real limit — it means a blank/garbled source cell. rateTracker treats a
    // declared 0 conservatively now, but the catalog should not be shipping them either.
    if (m.rpmLimit === 0 || m.rpdLimit === 0) {
      add('error', scope, `${id}: rpm/rpd of 0 — blank source cell, not "unlimited" (rpm=${m.rpmLimit} rpd=${m.rpdLimit})`);
    }
    // A huge requests-per-day is usually a token count in the wrong column — but not when it is
    // simply the ceiling implied by the per-minute limit (Cloudflare's 300 RPM = 432,000/day is
    // legitimate). Only flag a daily figure the RPM cannot possibly reach.
    const rpmCeiling = (m.rpmLimit ?? 0) * 1440;
    if (m.rpdLimit > 100_000 && m.rpdLimit > rpmCeiling) {
      add('error', scope, `${id}: rpdLimit=${m.rpdLimit} exceeds what rpm=${m.rpmLimit} allows in a day (${rpmCeiling}) — likely a token count`);
    }
    // `released` is a routing tiebreaker compared with localeCompare, so a tag list or an
    // unpadded month sorts wrongly and the model gets preferred as "newest".
    if (m.released != null && m.released !== '' && !/^\d{4}-\d{2}(-\d{2})?$/.test(String(m.released))) {
      add('error', scope, `${id}: released=${JSON.stringify(m.released)} is not YYYY-MM[-DD] — breaks recency sorting`);
    }
    // A tag cell that was never split on its delimiter.
    for (const t of m.tags ?? []) {
      if (typeof t === 'string' && t.length > 30 && t.includes('-') && !t.includes(' ')) {
        add('warn', scope, `${id}: tag ${JSON.stringify(t)} looks like an unsplit list`);
      }
    }
    // The free/paid signal the model picker actually renders.
    if (!m.monthlyTokenBudget || /^(TRUE|FALSE|\d+)$/i.test(String(m.monthlyTokenBudget))) {
      add('warn', scope, `${id}: monthlyTokenBudget=${JSON.stringify(m.monthlyTokenBudget)} renders as-is in the picker`);
    }
    // Trust pricing over the id string — "free" in a slug is not evidence. `llmgateway/
    // claude-haiku-4-5-free` carries Anthropic's real $1/$5 list price.
    const free = (m.tags ?? []).includes('free');
    if (free && /claude|gpt-4|gpt-5|o[1-9]-|gemini-\d+\.\d+-pro/i.test(m.modelId) && (m.origInputPricePer1M ?? 0) > 0) {
      add('warn', scope, `${id}: tagged free but is a frontier proprietary model at $${m.origInputPricePer1M}/$${m.origOutputPricePer1M} — verify it is not billed`);
    }
  }
}

async function main() {
  const bundled = JSON.parse(readFileSync(join(ROOT, 'media', 'catalog.json'), 'utf8'));
  structuralChecks(bundled.models, 'bundled');

  let workerModels = null;
  if (!OFFLINE) {
    const w = await getJson(WORKER_URL, 'worker');
    if (!w.ok) {
      add('warn', 'worker', `could not fetch ${WORKER_URL} (status ${w.status}${w.error ? `, ${w.error}` : ''}) — worker not validated`);
    } else {
      workerModels = (w.body.providers ?? []).flatMap((p) =>
        (p.models ?? []).map((m) => ({
          platform: String(p.provider_id ?? ''),
          modelId: String(m.model_id ?? m.modelId ?? m.id ?? ''),
          rpmLimit: m.rpm ?? m.rpmLimit,
          rpdLimit: m.rpd ?? m.rpdLimit,
          released: m.released,
          tags: m.tags,
          monthlyTokenBudget: m.monthly_token_budget ?? m.monthlyTokenBudget,
          origInputPricePer1M: m.pricing?.input ?? m.origInputPricePer1M,
          origOutputPricePer1M: m.pricing?.output ?? m.origOutputPricePer1M,
        })),
      );
      structuralChecks(workerModels, 'worker');

      // The failure this whole script exists for: the bundled file is fixed by hand, the worker
      // is not, and a single refresh silently reinstates whatever the worker still serves.
      const bundledKeys = new Set(bundled.models.map((m) => `${m.platform}/${m.modelId}`));
      const reintroduced = workerModels
        .map((m) => `${m.platform}/${m.modelId}`)
        .filter((k) => !bundledKeys.has(k));
      if (reintroduced.length) {
        add('warn', 'drift', `worker serves ${reintroduced.length} model(s) absent from the bundled catalog — a refresh will add them back: ${reintroduced.join(', ')}`);
      }
    }
  }

  const allModels = [...bundled.models, ...(workerModels ?? [])];
  const platforms = new Set(allModels.map((m) => m.platform));

  if (!OFFLINE) {
    // Retired products must stay dead.
    for (const [platform, url] of Object.entries(RETIRED_ENDPOINTS)) {
      const r = await getJson(url, platform);
      const gone = r.status === 410 || r.status === 404;
      if (platforms.has(platform)) {
        add(gone ? 'error' : 'warn', platform,
          gone ? `catalog still lists ${platform}, but ${url} returns HTTP ${r.status} (retired)`
               : `catalog lists ${platform} and ${url} answered HTTP ${r.status} — re-check whether it is back`);
      } else if (!gone && r.status) {
        add('warn', platform, `${url} answered HTTP ${r.status} — previously retired provider may be live again`);
      }
    }

    // Existence + free-ness against each provider's own published list.
    for (const [platform, src] of Object.entries(REMOTE_SOURCES)) {
      const rows = allModels.filter((m) => m.platform === platform);
      if (!rows.length) continue;
      const r = await getJson(src.url, platform);
      if (!r.ok) {
        add('warn', platform, `could not fetch ${src.url} (status ${r.status}) — ${rows.length} model(s) unverified`);
        continue;
      }
      const live = src.ids(r.body);
      for (const m of rows) {
        // Known-retired (see scripts/retiredModels.mjs): the bundled catalog already drops
        // them; a stale worker row here is expected until the worker refreshes — not an error.
        if (RETIRED_MODEL_KEYS.has(`${m.platform}||${m.modelId}`)) continue;
        // OpenRouter ids carry variant suffixes (`:free`); the base id is what the list contains.
        const base = m.modelId.replace(/:(free|extended|thinking|nitro|floor|online|exacto)$/, '');
        if (!live.has(m.modelId) && !live.has(base)) {
          add('error', platform, `${platform}/${m.modelId} is NOT in ${src.url} (${live.size} live models) — removed or renamed upstream`);
          continue;
        }
        const liveId = live.has(m.modelId) ? m.modelId : base;

        // Announced retirement — warn while there is still time to swap, error once past.
        const expiry = src.expiryOf?.(r.body, liveId);
        if (expiry) {
          const days = Math.floor((Date.parse(expiry) - Date.now()) / 86_400_000);
          // Some providers park a far-future sentinel (2098-12-31) on models with no real end
          // date; only treat a genuinely near date as news.
          if (days < 0) {
            add('error', platform, `${platform}/${m.modelId} expired upstream on ${expiry} — remove it`);
          } else if (days <= 30) {
            add('warn', platform, `${platform}/${m.modelId} is scheduled for retirement on ${expiry} (${days} day(s) away) — plan a replacement`);
          }
        }

        const price = src.priceOf(r.body, liveId);
        if (!price) continue; // provider publishes no pricing — existence verified, cost not
        const [inP, outP] = price;
        const taggedFree = (m.tags ?? []).includes('free');
        const actuallyFree = inP === 0 && outP === 0;
        if (taggedFree && !actuallyFree) {
          // Only an error where the zero-price listing IS the free offering. Elsewhere a paid
          // rate coexists with a separate free tier, so this is a prompt to check, not a defect.
          if (src.priceIsFreeness) {
            add('error', platform, `${platform}/${m.modelId} is tagged free but ${src.url} prices it at $${inP}/$${outP} per 1M — users would be billed`);
          } else {
            add('warn', platform, `${platform}/${m.modelId} tagged free; ${platform} lists $${inP}/$${outP} per 1M (its paid rate) — confirm the free tier still covers this model`);
          }
        } else if (!taggedFree && actuallyFree) {
          add('warn', platform, `${platform}/${m.modelId} is free upstream ($0/$0) but not tagged free`);
        }
      }
    }
  }

  const unverifiable = [...platforms].filter((p) => !REMOTE_SOURCES[p] && !RETIRED_ENDPOINTS[p]);
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (AS_JSON) {
    console.log(JSON.stringify({ errors, warns, unverifiable, checked: allModels.length }, null, 2));
  } else {
    for (const f of errors) console.log(`ERROR  [${f.scope}] ${f.message}`);
    for (const f of warns) console.log(`warn   [${f.scope}] ${f.message}`);
    console.log(`\n${errors.length} error(s), ${warns.length} warning(s) across ${allModels.length} catalog row(s).`);
    if (!OFFLINE && unverifiable.length) {
      console.log(`\nNot remotely verifiable (no public keyless models endpoint): ${unverifiable.sort().join(', ')}`);
      console.log('These rows are checked structurally only — their free/paid status is taken on trust.');
    }
  }
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => { console.error('validator failed:', e); process.exit(2); });

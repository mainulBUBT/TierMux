

import type { CatalogModel, Platform } from '../shared/types';

/**
 * Provider-list discovery: ask each provider what it currently serves, so the catalog can
 * add models that appeared and drop ones that vanished without a hand edit.
 *
 * Scope is deliberately the keyless providers only. The keyed ones (groq, mistral, cerebras,
 * zhipu, cohere, github, poolside, siliconflow, agnes) answer 401 without auth, and spending
 * a request against the user's key on every sync — plus handling nine auth dialects — buys
 * little when these twelve already cover ~1.3k models.
 *
 * What this CANNOT do: no provider reports `intelligenceRank`, `speedRank`, or `tags`, and
 * only Kenari reports tool support. Those come from `deriveMetadata` below, which reads the
 * model *name* — a signal every provider has, since names encode size ("70b"), tier
 * ("flash", "mini", "pro"), specialty ("coder"), and reasoning ("r1", "thinking").
 */

/** Platforms whose `/models` endpoint answers without an API key (measured, not assumed). */
export const DISCOVERABLE: Platform[] = [
  'huggingface', 'kenari', 'kilo', 'llm7', 'llmgateway', 'nvidia',
  'ollama', 'opencode', 'openrouter', 'ovh', 'sambanova', 'zenmux',
] as unknown as Platform[];

export interface DiscoveredModel {
  platform: Platform;
  modelId: string;
  contextWindow: number | null;
  supportsTools: boolean | undefined; // undefined = provider didn't say
  supportsVision: boolean | undefined;
  supportsReasoning: boolean | undefined;
  released?: string;
  free?: boolean;
}

export interface ProviderFetch {
  platform: Platform;
  /** null when the fetch was unhealthy — caller must NOT treat this as "provider has no models". */
  models: DiscoveredModel[] | null;
  error?: string;
}

const asArray = (body: unknown): unknown[] | null => {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const d = (body as Record<string, unknown>).data ?? (body as Record<string, unknown>).models;
    if (Array.isArray(d)) return d;
  }
  return null;
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

/** `created` is a unix seconds stamp on most providers → "YYYY-MM" for the recency tiebreak. */
function releasedFrom(v: unknown): string | undefined {
  const secs = typeof v === 'number' ? v : undefined;
  if (!secs || secs < 946_684_800 || secs > 4_102_444_800) return undefined; // 2000..2100 sanity
  const d = new Date(secs * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Tool support is reported under a different name (or not at all) by every provider. */
function toolsFrom(m: Record<string, unknown>): boolean | undefined {
  if (typeof m.tool_call === 'boolean') return m.tool_call;                  // kenari
  if (typeof m.supports_tools === 'boolean') return m.supports_tools;
  if (typeof m.function_calling === 'boolean') return m.function_calling;
  const caps = m.capabilities;                                               // zenmux, llm7
  if (Array.isArray(caps)) {
    const s = caps.map((c) => String(c).toLowerCase());
    if (s.some((c) => c.includes('tool') || c.includes('function'))) return true;
  }
  if (caps && typeof caps === 'object') {
    const c = caps as Record<string, unknown>;
    if (typeof c.tools === 'boolean') return c.tools;
    if (typeof c.tool_call === 'boolean') return c.tool_call;
  }
  return undefined;
}

function visionFrom(m: Record<string, unknown>): boolean | undefined {
  const mod = m.modalities ?? m.architecture;
  const input =
    (mod && typeof mod === 'object' ? (mod as Record<string, unknown>).input ?? (mod as Record<string, unknown>).input_modalities : undefined) ??
    m.input_modalities;
  if (Array.isArray(input)) return input.map((x) => String(x).toLowerCase()).includes('image');
  return undefined;
}

/** Normalize one provider's raw entry. Returns null for rows without a usable id. */
function normalize(platform: Platform, raw: unknown): DiscoveredModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const modelId = typeof m.id === 'string' ? m.id.trim() : '';
  if (!modelId) return null;

  const pricing = m.pricing && typeof m.pricing === 'object' ? (m.pricing as Record<string, unknown>) : undefined;
  const free =
    typeof m.free === 'boolean' ? m.free
      : typeof m.isFree === 'boolean' ? m.isFree
        : typeof pricing?.free === 'boolean' ? (pricing.free as boolean)
          : modelId.endsWith(':free') || undefined;

  return {
    platform,
    modelId,
    contextWindow: num(m.context_length) ?? num(m.context_window) ?? num(m.max_context_length),
    supportsTools: toolsFrom(m),
    supportsVision: visionFrom(m),
    supportsReasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
    released: releasedFrom(m.created),
    free,
  };
}

/** Fetch one provider's list. A non-200, unparseable body, or empty array is UNHEALTHY (null). */
export async function fetchProviderModels(
  platform: Platform,
  baseUrl: string,
  timeoutMs = 10_000,
): Promise<ProviderFetch> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { platform, models: null, error: `HTTP ${res.status}` };
    const arr = asArray(await res.json());
    if (!arr) return { platform, models: null, error: 'unrecognized body shape' };
    const models = arr.map((r) => normalize(platform, r)).filter((x): x is DiscoveredModel => !!x);
    // An empty list is treated as unhealthy, not as "this provider dropped everything" —
    // deleting a provider's whole catalog on one odd response is exactly the failure mode
    // the healthy-fetch gate exists to prevent.
    if (!models.length) return { platform, models: null, error: 'empty list' };
    return { platform, models };
  } catch (e) {
    return { platform, models: null, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

// ---------------------------------------------------------------------------
// Rank derivation
// ---------------------------------------------------------------------------

/** Largest parameter count mentioned in a model id, in billions (`8b`, `70b`, `120b-a12b`). */
function paramsB(id: string): number | undefined {
  const hits = [...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/g)]
    .map((m) => parseFloat(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0.5 && n <= 2000);
  return hits.length ? Math.max(...hits) : undefined;
}

const clampRank = (n: number): number => Math.max(1, Math.min(5, Math.round(n)));

/**
 * Measured intelligence ranks (1 = frontier … 5 = weak) for well-known model families, from
 * public MMLU-Pro / GPQA / HumanEval leaderboards (llm-stats, Open LLM Leaderboard). These
 * are REAL benchmark scores — not the estimated prices, which we deliberately ignore.
 *
 * Checked in order; the FIRST matching pattern wins, so list specific families before
 * generic ones. Models not matched here fall through to the param-count proxy in
 * deriveMetadata(). Speed is NOT table-driven — it is physics (tokens/s scales ~1/param
 * count, memory-bandwidth-bound), so it always derives from params below.
 *
 * Keep ranges coarse (±0.5 tier): the goal is correct ordering, not false precision. The
 * live runtime scorer (reliability/health) breaks ties and self-corrects.
 */
const BENCH_INTEL: Array<[RegExp, number]> = [
  // ---- Frontier / strong reasoning (1–1.5) ----
  [/nemotron.{0,4}ultra/i, 1],
  [/deepseek-r1\b/i, 1],
  [/gpt-4\.1\b(?!.*mini)/i, 1.5],
  [/gpt-4o\b(?!.*mini)/i, 1.5],
  [/glm-?5\b|glm-?5\.\d/i, 1.5],
  [/command-a.{0,3}plus/i, 1.5],
  [/kimi-k2\.[6-9]/i, 1.5],
  // ---- Strong (2) ----
  [/glm-?4\.[7-9]/i, 2],
  [/deepseek.{0,3}v[3-9]/i, 2],
  [/qwen3-coder/i, 2],
  [/gpt-oss-120b/i, 2],
  [/llama-3\.1-405b/i, 2],
  [/mistral-large/i, 2],
  [/command-a\b(?!.*vision)(?!.*reasoning)/i, 2],
  [/minimax-m2/i, 2],
  [/step-3\.[7-9]/i, 2],
  // ---- Capable (2.5) ----
  [/nemotron.{0,4}super/i, 2.5],
  [/llama-3\.3-70b/i, 2.5],
  [/qwen2\.5-coder/i, 2.5],
  [/qwen2\.5-72b/i, 2.5],
  [/mistral-medium/i, 2.5],
  [/pixtral-large/i, 2.5],
  // ---- Mid (3) ----
  [/gemma-?4-31b/i, 3],
  [/qwen3[.\-]?\d?-27b|qwen3[.\-]?\d?-30b/i, 3],
  [/gpt-oss-20b/i, 3.5],
  [/ling-3\.0/i, 3],
  [/codestral/i, 3],
  [/mistral-small/i, 3.5],
  // ---- Light (4+) ----
  [/gpt-4\.1-mini|gpt-4o-mini/i, 4],
  [/flash-lite/i, 4],
  [/north-mini/i, 4],
  [/mimo/i, 4],
  [/mistral-nemo|open-mistral-nemo/i, 4.5],
];

/** Measured intelligence rank from public benchmarks, or undefined to defer to the proxy. */
function benchIntel(id: string): number | undefined {
  for (const [re, rank] of BENCH_INTEL) {
    if (re.test(id)) return rank;
  }
  return undefined;
}

/**
 * Derive the curated-looking fields from whatever we have. Names carry most of the signal:
 * size, tier word, and specialty are all encoded there even for providers that return
 * nothing but an id. Deliberately conservative — an unrecognizable name lands on the
 * neutral middle rank (3) rather than pretending to a confidence we don't have.
 */
/**
 * Well-known open/free vision-model families whose id doesn't contain "vision", "vl",
 * "multimodal", or "omni" — the generic keyword check below misses these, which was
 * silently routing image turns away from free models that can actually see them.
 */
const KNOWN_VISION_FAMILIES =
  /llava|moondream|pixtral|cogvlm|cogagent|minicpm-v|idefics|fuyu|florence-?2|glm-?4\.?\d*v\b/;

/** Name-based vision heuristic, shared with router.ts for custom/local endpoints that have
 *  no catalog entry (and thus no measured `supportsVision`) to fall back on. */
export function isLikelyVisionModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /vision|vl\b|multimodal|omni/.test(id) || KNOWN_VISION_FAMILIES.test(id);
}

export function deriveMetadata(d: DiscoveredModel): Pick<
  CatalogModel,
  'intelligenceRank' | 'speedRank' | 'sizeLabel' | 'supportsTools' | 'supportsVision' | 'supportsReasoning' | 'tags'
> {
  const id = d.modelId.toLowerCase();
  const p = paramsB(id);

  const big = /\b(opus|ultra|pro|large|max|405b|" "|70b|72b|120b|235b|405b|671b)\b/.test(id);
  const small = /\b(mini|flash|lite|small|nano|tiny|instant|turbo|haiku|air)\b/.test(id);

  // Intelligence: prefer a measured benchmark rank when the family is known; otherwise fall
  // back to the param-count proxy (params dominate, tier word next, context as a nudge).
  const known = benchIntel(id);
  let intel = known ?? 3;
  if (known === undefined) {
    if (p !== undefined) intel = p >= 200 ? 1 : p >= 70 ? 2 : p >= 30 ? 2.5 : p >= 12 ? 3.5 : 4.5;
    else if (big) intel = 1.5;
    else if (small) intel = 4;
  }
  if ((d.contextWindow ?? 0) >= 1_000_000) intel -= 1;
  else if ((d.contextWindow ?? 0) >= 200_000) intel -= 0.5;

  // Speed is roughly the inverse: small/flash models are fast, huge ones are not.
  let speed = 3;
  if (small) speed = 1.5;
  else if (p !== undefined) speed = p >= 200 ? 5 : p >= 70 ? 4 : p >= 30 ? 3.5 : p >= 12 ? 2.5 : 1.5;
  else if (big) speed = 4;

  const tags: string[] = [];
  if (/cod(e|er|ing)|program|dev\b|swe\b/.test(id)) tags.push('coding');
  if (d.free) tags.push('free');

  return {
    intelligenceRank: clampRank(intel),
    speedRank: clampRank(speed),
    sizeLabel: p !== undefined ? `${p}B` : small ? 'small' : big ? 'large' : '',
    // Unknown tool support defaults to true on purpose: the router self-corrects via
    // markToolIncompatible on the first bad_request-with-tools, whereas defaulting to
    // false would silently exclude the model from agent mode forever with no way to learn.
    supportsTools: d.supportsTools ?? true,
    supportsVision: d.supportsVision ?? isLikelyVisionModelId(id),
    supportsReasoning: d.supportsReasoning ?? /\br1\b|reason|think|\bo[1-4]\b/.test(id),
    tags: tags.length ? tags : undefined,
  };
}

/** Build a full CatalogModel for a newly discovered model. */
export function toCatalogModel(d: DiscoveredModel): CatalogModel {
  const derived = deriveMetadata(d);
  return {
    platform: d.platform,
    modelId: d.modelId,
    displayName: d.modelId,
    ...derived,
    released: d.released,
    contextWindow: d.contextWindow,
    rpmLimit: null,
    rpdLimit: null,
    monthlyTokenBudget: '',
  };
}

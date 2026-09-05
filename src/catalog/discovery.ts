

import type { CatalogModel, Platform } from '../shared/types';

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

// ---------------------------------------------------------------------------
// Rank derivation
// ---------------------------------------------------------------------------

/** Largest parameter counts mentioned in a model id, in billions (`8b`, `70b`, `120b-a12b`). */
function paramsB(id: string): number | undefined {
  const hits = [...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/g)]
    .map((m) => parseFloat(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0.5 && n <= 2000);
  return hits.length ? Math.max(...hits) : undefined;
}

const clampRank = (n: number): number => Math.max(1, Math.min(5, Math.round(n)));

/**
 * Intelligence ranks (1 = frontier … 5 = weak) for well-known model families, from public
 * MMLU-Pro / GPQA / HumanEval leaderboards. Checked in order — first match wins, so list
 * specific families before generic ones; unmatched models fall through to the param-count
 * proxy in deriveMetadata(). Speed always derives from params (tokens/s scales ~1/params).
 * Keep ranges coarse: the goal is correct ordering, not false precision.
 */
const BENCH_INTEL: Array<[RegExp, number]> = [
  // R1 distills/students (r1-distill-*, r1-<size>b, r1-0528-qwen3-*) are 1.5–70B students of
  // the 671B teacher — mid-tier, slow, and think-loop prone: on Cloudflare, r1-distill-qwen-32b
  // burned its whole 16k output budget narrating a plan and truncated mid-sentence
  // (finish_reason=length, 2m24s, answer never started). Must be listed BEFORE `deepseek-r1\b`
  // below, which otherwise matches them via the `-` word boundary and hands them frontier rank.
  // The size branch lists the ACTUAL student sizes — a bare `-\d+b` also swallowed
  // `deepseek-r1-671b`, i.e. the frontier teacher itself, and demoted it from rank 1 to 3.5.
  [/r1.{0,6}distill|deepseek-r1-(?:1\.5|7|8|14|32|70)b|r1-\d{4}-qwen/i, 3.5],
  // ---- Frontier / strong reasoning (1–1.5) ----
  [/nemotron.{0,4}ultra/i, 1],
  [/deepseek-r1\b/i, 1],
  [/gpt-4\.1\b(?!.*mini)/i, 1.5],
  [/gpt-4o\b(?!.*mini)/i, 1.5],
  [/glm-?5\b|glm-?5\.\d/i, 1.5],
  [/command-a.{0,3}plus/i, 1.5],
  [/kimi-k2\.[6-9]|kimi-k3/i, 1.5],
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

/** Name-based vision heuristic for custom/local endpoints with no catalog `supportsVision`. */
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
    // Unknown tool support defaults to true on purpose: a 400-with-tools quarantines the model
    // (picker.noteModelFailure), whereas defaulting to false would exclude it from agent mode
    // forever with no way to learn.
    supportsTools: d.supportsTools ?? true,
    supportsVision: d.supportsVision ?? isLikelyVisionModelId(id),
    supportsReasoning: d.supportsReasoning ?? /\br1\b|reason|think|\bo[1-4]\b|kimi-k3/i.test(id),
    tags: tags.length ? tags : undefined,
  };
}

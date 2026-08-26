// v3 model picker (plan step 8) — replaces src/router/router.ts's 2,235-LOC selection logic
// and the whole scoring stack (scoring.ts, wilson.ts, metricsStore, rateTracker,
// latencyTracker, capabilityProfile). Query-type → candidate chain + a MINIMAL per-model
// cooldown. No learning, no hedging, no session pin, no circuit-breaker: a user can read
// this table and know exactly which model answers what. The cooldown re-adds only the
// lightweight "skip a model that just failed" behavior the delete-the-Router pass dropped;
// the rest of the Router's resilience machinery stays deleted.
//
// Sources (catalog/settings/secrets) are injected once at activation via setModelSources —
// same module-level wiring pattern the old setGates used. Headless callers that never set
// them still get a working default: keyless platforms from the static registry.

import type { Catalog } from '../catalog/catalog';
import type { SettingsStore } from '../config/settingsStore';
import type { SecretStore } from '../config/secrets';
import { allPlatformInfo } from '../providers';
import type { ChatMessage } from '../shared/types';
import { classifyTask, type TaskKind } from '../agent/routing';

/** platform::modelId → candidate chain per task kind. Ordered: best first. */
export const TASK_ROUTING: Record<TaskKind, string[]> = {
  coding: ['opencode::qwen3-coder', 'groq::llama-3.3-70b-versatile', 'cerebras::llama-3.3-70b', 'groq::qwen-2.5-coder-32b'],
  debug: ['groq::deepseek-r1-distill-llama-70b', 'opencode::deepseek-v3.1-free', 'cerebras::qwen-3-32b'],
  vision: ['google::gemini-2.5-flash', 'openrouter::qwen2.5-vl-72b-instruct', 'groq::llama-3.2-90b-vision-preview'],
  longContext: ['google::gemini-2.5-flash', 'groq::llama-3.3-70b-versatile', 'opencode::glm-4.6-flash-free'],
  plan: ['groq::llama-3.3-70b-versatile', 'opencode::glm-4.6-flash-free', 'cerebras::llama-3.3-70b'],
  trivial: ['groq::llama-3.1-8b-instant', 'opencode::qwen2.5-coder-7b', 'cerebras::llama-3.1-8b'],
  chat: ['groq::llama-3.3-70b-versatile', 'opencode::glm-4.6-flash-free', 'cerebras::llama-3.3-70b'],
  agent: ['opencode::qwen3-coder', 'groq::llama-3.3-70b-versatile', 'cerebras::llama-3.3-70b'],
};

export interface ModelSelection {
  /** First choice as `platform::modelId`. */
  model: string;
  /** Rest of the chain, tried in order on 429/5xx/network failure. */
  fallbackChain: string[];
  taskKind: TaskKind;
}

export interface ModelSources {
  catalog: Catalog;
  settings: SettingsStore;
  secrets: SecretStore;
}

let sources: ModelSources | undefined;

/** Wired once by extension.ts at activation (mirrors the old setGates pattern). */
export function setModelSources(s: ModelSources): void {
  sources = s;
}

/** API keys for a platform from the wired SecretStore — [''] for keyless platforms
 *  (BaseProvider.authHeader omits the header entirely). [] for a keyed platform with no
 *  stored key: the caller treats that as "candidate unavailable", so selection falls
 *  through to whatever the user CAN use instead of sending a guaranteed-401 request. */
export async function getApiKeysFor(platform: string): Promise<string[]> {
  const provider = allPlatformInfo().find((p) => p.platform === platform);
  if (provider?.keyless) return [''];
  if (!sources) return [];
  const keys = await sources.secrets.getKeys(platform as import('../shared/types').Platform);
  return keys.length ? keys : [];
}

/** Expand 'auto' into the full enabled-model list when no sources are wired (headless). */
function keylessFallback(): ModelSelection {
  const keyless = allPlatformInfo().filter((p) => p.keyless).map((p) => p.platform);
  const chain = keyless.map((p) => `${p}::auto`);
  return { model: chain[0] ?? 'groq::llama-3.3-70b-versatile', fallbackChain: chain.slice(1), taskKind: 'chat' };
}

/** Minimal per-model health (cooldown) — the ONLY resilience state the v3 picker keeps.
 *  A model that fails (429/5xx/timeout/network) is skipped until its cooldown elapses, so the
 *  fallback chain prefers healthy models; a success resets the streak. Exponential backoff
 *  (30s base → 2m cap) keeps a persistently-broken model from being retried every call
 *  without the full circuit-breaker the deleted Router had. In-memory only (resets on reload)
 *  — deliberate: this is "don't hammer a model that just 429'd", not durability. */
interface ModelHealth { failures: number; cooldownUntil: number; }
const modelHealth = new Map<string, ModelHealth>();
const HEALTH_BASE_MS = 30_000;
const HEALTH_MAX_MS = 2 * 60_000;
function healthKey(platform: string, modelId: string): string { return `${platform}::${modelId}`; }
function cooldownFor(failures: number): number {
  return Math.min(HEALTH_BASE_MS * 2 ** Math.max(0, failures - 1), HEALTH_MAX_MS);
}
export function recordOutcome(platform: string, modelId: string, ok: boolean): void {
  const key = healthKey(platform, modelId);
  if (ok) { modelHealth.set(key, { failures: 0, cooldownUntil: 0 }); return; }
  const failures = (modelHealth.get(key)?.failures ?? 0) + 1;
  modelHealth.set(key, { failures, cooldownUntil: Date.now() + cooldownFor(failures) });
}
export function isInCooldown(platform: string, modelId: string): boolean {
  const h = modelHealth.get(healthKey(platform, modelId));
  return !!h && h.cooldownUntil > Date.now();
}

/** The v3 selection: classify → table → pinned/user order first → enabled filter.
 *  `modelId` 'auto' inside a key (e.g. `kilo::auto`) is resolved to the platform's best
 *  enabled model when sources are wired. */
export async function selectModel(
  messages: ChatMessage[],
  opts: { pinnedModel?: string; excludeModels?: string[]; taskKind?: string; sessionId?: string; requireTools?: boolean } = {},
): Promise<ModelSelection> {
  if (!sources) return keylessFallback();

  const text = messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n');
  const taskKind = (opts.taskKind as TaskKind | undefined) ?? classifyTask(text);
  const enabled = new Set(
    sources.settings.getFallback().filter((e) => e.enabled).map((e) => `${e.platform}::${e.modelId}`),
  );
  const exclude = new Set(opts.excludeModels ?? []);

  // "Enabled AND usable": a keyed platform with no stored key is as unavailable as a
  // disabled model — checking this HERE (not after candidate resolution) is what lets the
  // fallback loops below reach keyless platforms instead of shipping a chain whose every
  // entry dies at resolveCandidates. Memoized: SecretStore lookups are async.
  const usableCache = new Map<string, boolean>();
  const platformUsable = async (platform: string): Promise<boolean> => {
    if (usableCache.has(platform)) return usableCache.get(platform)!;
    const keys = await getApiKeysFor(platform);
    const ok = keys.length > 0;
    usableCache.set(platform, ok);
    return ok;
  };

  const pick = async (key: string): Promise<string | undefined> => {
    if (exclude.has(key)) return undefined;
    const platform = key.endsWith('::auto') ? key.slice(0, -6) : key.split('::')[0];
    const modelId = key.endsWith('::auto') ? '' : key.split('::').slice(1).join('::');
    if (!(await platformUsable(platform))) return undefined;
    // Per-model cooldown: skip a model still inside its failure cooldown (429/5xx/timeout) so
    // the chain prefers healthy models. The pinned model is exempt — explicit user choice,
    // only the Stop button cancels it.
    if (modelId && isInCooldown(platform, modelId) && key !== opts.pinnedModel) return undefined;
    if (key.endsWith('::auto')) {
      const hit = [...enabled].find((k) => k.startsWith(`${platform}::`) && !exclude.has(k));
      return hit;
    }
    if (enabled.size > 0 && !enabled.has(key) && opts.pinnedModel !== key) return undefined;
    // Tool-capability filter — the OLD Router's requireTools rule (router.ts:779/867): an
    // agent turn offers tools, so a model the catalog marks supportsTools=false can never
    // call them and deflects instead ("I don't have access to…"). Without this, Auto picks
    // non-tool models and every tool — webSearch/fetchUrl included — silently "doesn't work".
    if (opts.requireTools && sources) {
      const modelId = key.split('::').slice(1).join('::');
      const meta = sources.catalog.find(platform, modelId);
      if (meta?.supportsTools === false) return undefined;
      if (sources.secrets.isToolIncompatible?.(platform as never, modelId)) return undefined;
    }
    return key;
  };

  const chain: string[] = [];
  if (opts.pinnedModel) {
    const pinned = await pick(opts.pinnedModel);
    if (pinned) chain.push(pinned);
  }
  for (const key of TASK_ROUTING[taskKind] ?? TASK_ROUTING.chat) {
    const picked = await pick(key);
    if (picked && !chain.includes(picked)) chain.push(picked);
  }
  // ALWAYS pad the chain with the rest of the usable enabled models (dedup, settings
  // priority order). The old "only when empty" rule left a pinned model with a
  // SINGLE candidate — nothing to fail over to when it 429'd or died, which is exactly
  // "failover doesn't work" in production (observed live: pinned groq model, 1s fast-fail,
  // 0 tokens). With the tail, every chain is: pinned → table picks → rest of enabled.
  for (const key of enabled) {
    const picked = await pick(key);
    if (picked && !chain.includes(picked)) chain.push(picked);
  }
  if (chain.length === 0) return keylessFallback();

  return { model: chain[0], fallbackChain: chain.slice(1), taskKind };
}

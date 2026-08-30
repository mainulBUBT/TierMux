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
  // NOTE: every id here MUST exist in media/catalog.json — 11 of the previous 13 were dead
  // (groq renamed to namespaced ids, opencode renamed its free tier, cerebras swapped
  // models), so the table silently contributed NOTHING and every Auto turn fell straight
  // into the user's settings-order tail. When gateways rename again, these go dead the same
  // silent way — which is why the tail below is rank-sorted, not table-dependent.
  coding: ['groq::openai/gpt-oss-120b', 'cerebras::gpt-oss-120b', 'opencode::muse-spark-1.2-contributor-free', 'opencode::nemotron-3-ultra-free', 'opencode::big-pickle'],
  debug: ['groq::openai/gpt-oss-120b', 'cerebras::gpt-oss-120b', 'opencode::nemotron-3-ultra-free'],
  vision: ['google::gemini-2.5-flash'],
  longContext: ['google::gemini-2.5-flash', 'groq::openai/gpt-oss-120b', 'opencode::muse-spark-1.2-contributor-free'],
  plan: ['groq::openai/gpt-oss-120b', 'opencode::muse-spark-1.2-contributor-free', 'opencode::hy3-free'],
  trivial: ['cerebras::gemma-4-31b', 'groq::openai/gpt-oss-20b', 'opencode::mimo-v2.5-free'],
  chat: ['groq::openai/gpt-oss-120b', 'opencode::muse-spark-1.2-contributor-free', 'opencode::hy3-free'],
  agent: ['groq::openai/gpt-oss-120b', 'cerebras::gpt-oss-120b', 'opencode::muse-spark-1.2-contributor-free', 'opencode::nemotron-3-ultra-free', 'opencode::big-pickle'],
};

/** One row of the "Why this model?" report — numeric fields mirror the old scoring Router's
 *  shape so the webview popover renders unchanged (it calls .toFixed on score/capability/
 *  runtime/confidence). Runtime 1.0 / confidence 0 = v3 keeps no learned health multiplier. */
export interface SelectionRationale {
  taskKind: TaskKind;
  picked?: string;
  entries: Array<{
    model: string;
    selected: boolean;
    score: number;
    capability: number;
    runtime: number;
    preference: number;
    confidence: number;
    reason: string;
    /** Skip reason when absent from the chain (mirrors the old Router's string skip). */
    skip?: string;
  }>;
}

export interface ModelSelection {
  /** First choice as `platform::modelId`. */
  model: string;
  /** Rest of the chain, tried in order on 429/5xx/network failure. */
  fallbackChain: string[];
  taskKind: TaskKind;
  /** Present when sources are wired — drives the footer's "Why this model?" popup. */
  rationale?: SelectionRationale;
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
  // Empty strings must not count as "usable": a stale '' entry in the pool passed the
  // platformUsable check, then died at provider key parsing instead of failing over
  // (live repro 2026-08-28: turns killed by `Cloudflare key must be "account_id:api_token"`
  // at 18:22/18:44 with cloudflare unticked and no key set in the UI).
  const keys = (await sources.secrets.getKeys(platform as import('../shared/types').Platform)).filter((k) => k.trim());
  if (platform === 'cloudflare') {
    // Cloudflare stores accountId and token SEPARATELY; the wire format is
    // `accountId:token` (CloudflareProvider.parseKey throws on a bare token). The legacy
    // router path assembles this in SecretStore.resolveKey, but the v3 chat path hands the
    // raw pool straight to the provider — so an enabled cloudflare model passed
    // platformUsable and then killed the whole turn in parseKey. Mirror resolveKey here and
    // treat "no accountId stored" as "platform unavailable" so selection skips it.
    const accountId = await sources.secrets.getCloudflareAccountId();
    if (!accountId) return [];
    return keys.map((k) => (k.startsWith(accountId + ':') ? k : `${accountId}:${k}`));
  }
  return keys;
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
  // enabledByPriority(), NOT getFallback(): the provider-level switch in Manage Models & Keys
  // stores its state in a SEPARATE disabled-providers list and never clears the per-model
  // `enabled` flags, so a raw getFallback() filter still reports every model of a switched-off
  // provider as selectable. The deleted Router read enabledByPriority() and honoured the
  // switch; v3's picker read getFallback() and did not, which made the switch cosmetic for
  // Auto/Smart routing — a provider toggled off (with a key still stored, so platformUsable
  // passes) kept serving turns.
  const enabled = new Set(
    sources.settings.enabledByPriority().map((e) => `${e.platform}::${e.modelId}`),
  );
  const disabledProviders = new Set<string>(sources.settings.getDisabledProviders());
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

  // "Why this model?" data — every candidate considered is recorded with WHY it made the
  // chain or was skipped. The old scoring Router produced these; v3's table+tail selection
  // never did, so the footer's (?)/⇄ button had nothing to show (live repro 2026-08-28:
  // clicking it rendered no popup). Numbers: capability derives from the catalog's
  // intelligence rank; Runtime is neutral 1.0 with confidence 0 — v3 keeps no learned
  // health multiplier, and the popover's tooltips present those values as exactly that.
  const skipReasons = new Map<string, string>();
  const pickLabels = new Map<string, string>();
  const skip = (key: string, reason: string) => { if (!skipReasons.has(key)) skipReasons.set(key, reason); };
  // Models the provider switch removed never reach pick(), so without this they vanish from
  // the report entirely — and "it silently stopped using my models" is the same confusion,
  // inverted, as the bug the switch fix closed. Seed them so the popover SAYS why.
  for (const e of sources.settings.getFallback()) {
    if (e.enabled && disabledProviders.has(e.platform)) {
      skip(`${e.platform}::${e.modelId}`, 'provider switched off in Manage Models & Keys');
    }
  }
  const pick = async (key: string, label: string): Promise<string | undefined> => {
    if (exclude.has(key)) { skip(key, 'excluded for this retry'); return undefined; }
    const platform = key.endsWith('::auto') ? key.slice(0, -6) : key.split('::')[0];
    const modelId = key.endsWith('::auto') ? '' : key.split('::').slice(1).join('::');
    // Provider switched off in Manage Models & Keys — checked before the key lookup so the
    // rationale says "provider off" rather than blaming a key that is actually stored. The
    // pinned model is exempt for the same reason it is exempt from the enabled filter below:
    // explicit user choice for this one turn.
    if (disabledProviders.has(platform) && key !== opts.pinnedModel) { skip(key, 'provider switched off in Manage Models & Keys'); return undefined; }
    if (!(await platformUsable(platform))) { skip(key, 'no API key stored for this platform'); return undefined; }
    // Per-model cooldown: skip a model still inside its failure cooldown (429/5xx/timeout) so
    // the chain prefers healthy models. The pinned model is exempt — explicit user choice,
    // only the Stop button cancels it.
    if (modelId && isInCooldown(platform, modelId) && key !== opts.pinnedModel) { skip(key, 'in failure cooldown (recent errors)'); return undefined; }
    if (key.endsWith('::auto')) {
      const hit = [...enabled].find((k) => k.startsWith(`${platform}::`) && !exclude.has(k));
      if (!hit) skip(key, 'platform enabled but no enabled model');
      else pickLabels.set(hit, label);
      return hit;
    }
    if (enabled.size > 0 && !enabled.has(key) && opts.pinnedModel !== key) { skip(key, 'not enabled in Manage Models & Keys'); return undefined; }
    // Tool-capability filter — the OLD Router's requireTools rule (router.ts:779/867): an
    // agent turn offers tools, so a model the catalog marks supportsTools=false can never
    // call them and deflects instead ("I don't have access to…"). Without this, Auto picks
    // non-tool models and every tool — webSearch/fetchUrl included — silently "doesn't work".
    if (opts.requireTools && sources) {
      const modelId = key.split('::').slice(1).join('::');
      const meta = sources.catalog.find(platform, modelId);
      if (meta?.supportsTools === false) { skip(key, 'catalog says this model cannot call tools'); return undefined; }
      if (sources.secrets.isToolIncompatible?.(platform as never, modelId)) { skip(key, 'tool-incompatible platform'); return undefined; }
    }
    pickLabels.set(key, label);
    return key;
  };

  const chain: string[] = [];
  if (opts.pinnedModel) {
    const pinned = await pick(opts.pinnedModel, 'pinned by you');
    if (pinned) chain.push(pinned);
  }
  for (const key of TASK_ROUTING[taskKind] ?? TASK_ROUTING.chat) {
    const picked = await pick(key, `task table (${taskKind})`);
    if (picked && !chain.includes(picked)) chain.push(picked);
  }
  // ALWAYS pad the chain with the rest of the usable enabled models (dedup), ordered by the
  // catalog's measured intelligence rank — best first — with unranked models keeping their
  // settings order after the ranked ones. The old "settings order" tail is how a
  // paper-strong-but-live-weak model served EVERY task (live repro 2026-08-28, 1:29 AM:
  // opencode/nemotron-3-ultra-free narrated a plan instead of acting on "@routes/web.php
  // optimize this" — it sat first in settings order after the task table's dead ids were
  // all skipped). Pinned models stay exempt (explicit user choice above).
  const ranked: Array<{ key: string; rank: number }> = [];
  for (const key of enabled) {
    // Already chained (pin/table pick)? Skip BEFORE re-picking: pick() would overwrite the
    // entry's original label ('pinned by you' / 'task table (chat)') with 'enabled model' and
    // the "Why this model?" popover would lie about WHY it served (live repro 2026-08-28:
    // table-picked opencode/hy3-free reported "enabled model — serves this turn").
    if (chain.includes(key)) continue;
    const picked = await pick(key, 'enabled model');
    if (!picked || chain.includes(picked)) continue;
    const platform = key.split('::')[0];
    const modelId = key.split('::').slice(1).join('::');
    const meta = sources.catalog.find(platform, modelId);
    ranked.push({ key: picked, rank: meta?.intelligenceRank ?? Number.POSITIVE_INFINITY });
  }
  ranked.sort((a, b) => a.rank - b.rank); // stable — equal/unknown ranks keep settings order
  for (const r of ranked) {
    if (Number.isFinite(r.rank)) pickLabels.set(r.key, `enabled tail · intelligence rank ${r.rank}`);
    chain.push(r.key);
  }
  if (chain.length === 0) return keylessFallback();

  // Assemble the "Why this model?" report: chain in order (chain[0] = selected), then every
  // skipped candidate with its reason. Chain positions after 0 are failover order.
  const rankOf = (key: string): number | undefined => {
    const platform = key.split('::')[0];
    const modelId = key.split('::').slice(1).join('::');
    const meta = sources?.catalog.find(platform, modelId);
    return meta && typeof meta.intelligenceRank === 'number' ? meta.intelligenceRank : undefined;
  };
  const rationale: SelectionRationale = {
    taskKind,
    picked: chain[0],
    entries: [
      ...chain.map((key, i) => {
        const rank = rankOf(key);
        const capability = rank !== undefined ? +((6 - rank) / 5).toFixed(2) : 0.5;
        const label = pickLabels.get(key) ?? 'enabled model';
        return {
          model: key,
          selected: i === 0,
          score: capability, capability, runtime: 1, preference: 1, confidence: 0,
          reason: i === 0 ? `${label} — serves this turn` : `${label} — failover #${i}`,
        };
      }),
      ...[...skipReasons.entries()]
        .filter(([key]) => !chain.includes(key))
        .map(([key, reason]) => ({
          model: key, selected: false, score: 0, capability: 0, runtime: 1, preference: 1, confidence: 0,
          reason, skip: reason,
        })),
    ],
  };

  return { model: chain[0], fallbackChain: chain.slice(1), taskKind, rationale };
}

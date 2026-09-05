// Model picker: task kind → candidate chain, plus per-model cooldown and declared rpm/rpd
// windows. Ordering is readable: pin → task table → speed class → intelligence rank, with an
// OPTIONAL user-feedback tiebreak (👍/👎 from ModelStatsStore) that picks the preferred model
// among otherwise-equal peers. No learned health scoring, no hedging — a slow-model demotion
// was tried for a day in 2026-09 and removed; do not re-add. Sources are injected at
// activation via setModelSources; headless callers get keyless platforms only.

import type { Catalog } from '../catalog/catalog';
import type { SettingsStore } from '../config/settingsStore';
import type { SecretStore } from '../config/secrets';
import type { ModelStatsStore } from '../config/modelStats';
import { allPlatformInfo } from '../providers';
import type { ChatMessage, CatalogModel } from '../shared/types';
import { classifyTask, type TaskKind } from '../agent/routing';
import { RateTracker } from './rateTracker';
import type { QuotaStore } from '../config/quotaStore';
import { diagLog } from '../util/diag';

/** Skip reason for a model whose provider the user switched off — recorded so no other reason
 *  can claim it, never reported (see the skipList filter). */
const PROVIDER_OFF = 'provider switched off in Manage Models & Keys';

/** platform::modelId → candidate chain per task kind. Ordered: best first. */
export const TASK_ROUTING: Record<TaskKind, string[]> = {
  // Every id here MUST exist in media/catalog.json; a renamed gateway id goes dead silently
  // (11 of 13 were once dead), which is why the tail below is rank-sorted, not table-dependent.
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
    /** Keyless platforms need no API key — the webview lists only these as candidates. */
    keyless?: boolean;
  }>;
}

/** Re-point a rationale at the model that ACTUALLY served the turn. selectModel() builds the
 *  report before a byte is sent, so after a failover the popover named a model that never ran
 *  (2026-08-31). Candidates passed over on the way are relabelled tried-and-failed. Unchanged
 *  when the served model is already selected or not in the report. */
export function rationaleForServed(
  rationale: SelectionRationale,
  platform: string,
  modelId: string,
): SelectionRationale {
  const served = `${platform}::${modelId}`;
  if (rationale.picked === served) return rationale;
  const at = rationale.entries.findIndex((e) => e.model === served);
  if (at === -1) return rationale;
  return {
    ...rationale,
    picked: served,
    entries: rationale.entries.map((e, i) => {
      if (e.model === served) {
        // Keep the label that explains HOW it got into the chain, drop the "failover #n"
        // tail — it is not a failover any more, it is the answer.
        const how = e.reason.replace(/\s*—\s*failover #\d+$/, '').replace(/\s*—\s*serves this turn$/, '');
        return { ...e, selected: true, reason: `${how} — served this turn` };
      }
      // Only candidates BEFORE the winner were actually attempted; later ones were never dialed.
      if (i < at && !e.skip) {
        const how = e.reason.replace(/\s*—\s*(serves this turn|failover #\d+)$/, '');
        return { ...e, selected: false, reason: `${how} — tried first, failed over` };
      }
      return { ...e, selected: false };
    }),
  };
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
  /** Optional per-task-kind 👍/👎 feedback store. When wired, a model's net vote score
   *  breaks ties among otherwise-equal peers (same speed class + intelligence rank).
   *  Absent for headless/library callers, so ordering there equals no-vote behavior. */
  stats?: ModelStatsStore;
}

let sources: ModelSources | undefined;

/** Wired once by extension.ts at activation. */
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
    // Cloudflare stores accountId and token separately; the wire format is `accountId:token`
    // (parseKey throws on a bare token). No accountId ⇒ platform unavailable.
    const accountId = await sources.secrets.getCloudflareAccountId();
    if (!accountId) return [];
    return keys.map((k) => (k.startsWith(accountId + ':') ? k : `${accountId}:${k}`));
  }
  return keys;
}

/** Whether a model key needs no API key — keyless platforms run free with zero setup. The
 *  webview's "Other candidates" section lists only keyless models (the fallbacks that can
 *  actually join a turn), so the picker stamps every rationale entry with this flag. */
function keylessOf(key: string): boolean {
  return allPlatformInfo().find((p) => p.platform === key.split('::')[0])?.keyless ?? false;
}

/** Net user feedback (👍−👎) for a model on this task kind. 0 when no stats store is wired
 *  (headless/library) or no votes exist, so the comparator collapses back to today's exact
 *  ordering. */
function voteScore(taskKind: string, key: string): number {
  const sep = key.indexOf('::');
  return sources?.stats?.score(taskKind, sep >= 0 ? key.slice(0, sep) : key, sep >= 0 ? key.slice(sep + 2) : '') ?? 0;
}

/** Declared-quota accounting, inherited from the deleted Router (plan §4.2). Hydrated from the
 *  QuotaStore at activation so a window reload keeps respecting limits already consumed.
 *  Module-level like the health map: one tracker per extension host. */
let rateTracker = new RateTracker();
export function setQuotaStore(store: QuotaStore | undefined): void {
  rateTracker = new RateTracker(store);
}
/** Record a request against the declared rpm/rpd windows — called on every served candidate. */
export function recordRequest(platform: string, modelId: string): void {
  rateTracker.record(platform, modelId);
}

/** Catalog lookup through the wired sources — lets callers resolve a served model's metadata
 *  (context window, ranks) without holding their own Catalog reference. `undefined` when no
 *  sources are wired (headless) or the id is not in the catalog, which every caller must treat
 *  as "unknown model" rather than an error. */
export function findCatalogModel(platform: string, modelId: string): CatalogModel | undefined {
  return sources?.catalog.find(platform, modelId);
}

/** The model that WOULD serve this task kind right now, without a request (the auto-compaction
 *  budget needs its context window before the turn starts). Saves/restores the rotation
 *  counter so a peek never changes what the next real turn picks. */
export async function peekTopModel(taskKind: string): Promise<CatalogModel | undefined> {
  if (!sources) return undefined;
  const saved = taskRoundCounters.get(taskKind);
  try {
    const sel = await selectModel([], { taskKind, requireTools: true });
    const [platform, ...rest] = sel.model.split('::');
    return findCatalogModel(platform, rest.join('::'));
  } catch {
    return undefined; // a peek must never fail a turn
  } finally {
    if (saved === undefined) taskRoundCounters.delete(taskKind);
    else taskRoundCounters.set(taskKind, saved);
  }
}

/** Expand 'auto' into the full enabled-model list when no sources are wired (headless). */
function keylessFallback(): ModelSelection {
  const keyless = allPlatformInfo().filter((p) => p.keyless).map((p) => p.platform);
  const chain = keyless.map((p) => `${p}::auto`);
  return { model: chain[0] ?? 'groq::llama-3.3-70b-versatile', fallbackChain: chain.slice(1), taskKind: 'chat' };
}

/** Per-model cooldown — the ONLY resilience state the picker keeps. A failing model is skipped
 *  until its cooldown elapses; a success resets it. Exponential 30s → 10m. In-memory only:
 *  persisting it (tried 2026-09-04) left stale cooldowns shadowing recovered models. */
interface ModelHealth { failures: number; cooldownUntil: number; }
const modelHealth = new Map<string, ModelHealth>();
const HEALTH_BASE_MS = 30_000;
/** 2m → 10m (2026-09-04): a 429/500-ing free provider stays down for minutes, and a 2-minute
 *  memory re-paid its failure latency on almost every turn. The 30s base still lets a
 *  recovered model back within a minute of its FIRST failure. */
const HEALTH_MAX_MS = 10 * 60_000;
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

/** Time-boxed quarantines on top of the cooldown, for failures that say something specific
 *  about the MODEL rather than the moment: a 400 while tools were offered means it rejects the
 *  tools payload (10 min), a 404 means it is gone from the provider (24 h). The old Router set
 *  these; the picker read them but nothing had set them since it was retired (2026-09-05). */
export function noteModelFailure(platform: string, modelId: string, status: number | undefined, toolsOffered: boolean): void {
  if (!sources) return;
  if (status === 404) sources.secrets.markDeprecated?.(platform as never, modelId);
  else if ((status === 400 || status === 413) && toolsOffered) sources.secrets.markToolIncompatible?.(platform as never, modelId);
}

/** The model behind a catalog row, independent of who serves it: `openai/gpt-oss-120b` on
 *  groq, `gpt-oss-120b` on cerebras and `openai/gpt-oss-120b:free` on openrouter are one
 *  model. Ranking is by MODEL; speed stays per row, because the same weights on a slow gateway
 *  genuinely are slower. */
export function canonicalModelId(modelId: string): string {
  return modelId.toLowerCase()
    .replace(/^[^/]+\//, '')            // vendor namespace: openai/, nvidia/, @cf/meta/…
    .replace(/:(free|latest)$/, '')       // gateway tier suffix
    .replace(/-free$/, '')
    .replace(/[-_.]instruct$|[-_.]it$/, '');
}

/** Intelligence rank per MODEL, not per row. The catalog derives a rank per provider row, so
 *  the same model carried different ranks on different gateways (nemotron-3-super: 2 on kilo,
 *  6 on openrouter) and the tail interleaved them as if they were different models. The best
 *  rank any provider reports for the model is the model's rank. */
function rankByModel(keys: Iterable<string>): Map<string, number> {
  const best = new Map<string, number>();
  if (!sources) return best;
  for (const key of keys) {
    const platform = key.split('::')[0];
    const modelId = key.split('::').slice(1).join('::');
    const r = sources.catalog.find(platform, modelId)?.intelligenceRank;
    if (typeof r !== 'number') continue;
    const id = canonicalModelId(modelId);
    best.set(id, Math.min(best.get(id) ?? Number.POSITIVE_INFINITY, r));
  }
  return best;
}

/** Monotonic per-task-kind counter driving the equal-rank rotation — module-level so it
 *  advances across turns within a session (and across sessions sharing this module).
 *  Post-increment: the FIRST call returns 0 (no rotation — picker order stands until a
 *  same-rank peer has proven itself), then 1, 2, … walk the group. */
const taskRoundCounters = new Map<string, number>();
function nextTaskRound(kind: string): number {
  const cur = taskRoundCounters.get(kind) ?? 0;
  taskRoundCounters.set(kind, cur + 1);
  return cur;
}

/** Test seam ONLY — routing-gates e2e resets the rotation counters between blocks so
 *  order-sensitive assertions are deterministic. Production never calls this. */
export function __resetTaskRoundCounters(): void {
  taskRoundCounters.clear();
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
  // enabledByPriority(), NOT getFallback(): the provider-level switch lives in a separate
  // disabled-providers list and never clears per-model `enabled` flags, so getFallback() still
  // offered every model of a switched-off provider.
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

  // "Why this model?" data — every candidate considered, with WHY it made the chain or was
  // skipped. Capability derives from intelligence rank; Runtime is a neutral 1.0 with
  // confidence 0 (no learned health multiplier exists).
  const skipReasons = new Map<string, string>();
  const pickLabels = new Map<string, string>();
  const skip = (key: string, reason: string) => { if (!skipReasons.has(key)) skipReasons.set(key, reason); };
  // Seeded FIRST so a switched-off provider's model can never be blamed on a missing key
  // (skip() keeps the first reason). They are then dropped from the report below: the user
  // switched them off, so they are not candidates, and listing ten of them ate the skip cap
  // that cooldown / no-key entries actually need (2026-09-05).
  for (const e of sources.settings.getFallback()) {
    if (e.enabled && disabledProviders.has(e.platform)) {
      skip(`${e.platform}::${e.modelId}`, PROVIDER_OFF);
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
    if (disabledProviders.has(platform) && key !== opts.pinnedModel) { skip(key, PROVIDER_OFF); return undefined; }
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
    // An agent turn offers tools, so a model the catalog marks supportsTools=false would
    // deflect ("I don't have access to…") and every tool would silently "not work".
    // Declared rpm/rpd quota from the catalog: free tiers publish hard limits, and learning one
    // by being 429'd costs a real request plus a cooldown.
    if (sources) {
      const modelId = key.split('::').slice(1).join('::');
      const meta = sources.catalog.find(platform, modelId);
      if (meta && !rateTracker.canSend(platform, modelId, meta.rpmLimit, meta.rpdLimit)) {
        skip(key, 'at its declared rate limit (rpm/rpd) right now');
        return undefined;
      }
    }
    if (sources) {
      const modelId = key.split('::').slice(1).join('::');
      if (sources.secrets.isDeprecated?.(platform as never, modelId) && opts.pinnedModel !== key) {
        skip(key, 'the provider returned 404 for this model — deprecated or removed'); return undefined;
      }
      if (opts.requireTools) {
        const meta = sources.catalog.find(platform, modelId);
        if (meta?.supportsTools === false) { skip(key, 'catalog says this model cannot call tools'); return undefined; }
        if (sources.secrets.isToolIncompatible?.(platform as never, modelId)) { skip(key, 'tool-incompatible platform'); return undefined; }
      }
    }
    pickLabels.set(key, label);
    return key;
  };

  const chain: string[] = [];
  // 'auto' is the webview selector's default and arrives as pinnedModel on every Auto send —
  // it means "no pin", never a model named auto (2026-09-01: every Auto turn died as an
  // unroutable pin).
  if (opts.pinnedModel && opts.pinnedModel !== 'auto') {
    const pinned = await pick(opts.pinnedModel, 'pinned by you');
    if (pinned) {
      // PIN = EXACT (2026-08-31, user direction): a set model runs ALONE. Padding the pin with
      // the tail let a failing pin be answered by another provider's model while the footer
      // still credited the pin.
      return {
        model: pinned,
        fallbackChain: [],
        taskKind,
        rationale: {
          taskKind,
          picked: pinned,
          entries: [{
            model: pinned, selected: true,
            score: 1, capability: 1, runtime: 1, preference: 1, confidence: 0,
            reason: 'pinned by you — serves this turn (no failover: a set model runs alone)',
            keyless: keylessOf(pinned),
          }],
        },
      };
    }
    // The pin could not be honored at all (no key / excluded as unavailable). Rerouting would
    // repeat the exact "asked for A, got B" confusion, so hand back an empty selection with
    // the skip reason — resolveCandidates turns it into a visible turn error. The one
    // exception is a deliberate excludeModels retry, where moving past the pin IS the point.
    if (!exclude.has(opts.pinnedModel)) {
      const reason = skipReasons.get(opts.pinnedModel) ?? 'unavailable';
      return {
        model: '',
        fallbackChain: [],
        taskKind,
        rationale: {
          taskKind,
          entries: [{
            model: opts.pinnedModel, selected: false,
            score: 0, capability: 0, runtime: 1, preference: 1, confidence: 0,
            reason, skip: reason,
            keyless: keylessOf(opts.pinnedModel),
          }],
        },
      };
    }
  }
  for (const key of TASK_ROUTING[taskKind] ?? TASK_ROUTING.chat) {
    const [tPlatform, ...tRest] = key.split('::');
    const tModelId = tRest.join('::');
    // Dead-ID guard: a renamed/retired gateway model must say so in the rationale instead of
    // silently contributing nothing while the turn falls into the settings-order tail.
    if (tPlatform && tModelId && !sources.catalog.find(tPlatform, tModelId) && !skipReasons.has(key)) {
      skip(key, 'routing table entry not in catalog (renamed or retired?)');
    }
    const picked = await pick(key, `task table (${taskKind})`);
    if (picked && !chain.includes(picked)) chain.push(picked);
  }
  // ALWAYS pad the chain with the rest of the usable enabled models, best intelligence rank
  // first (settings order let whichever model sat first serve every task — 2026-08-28,
  // nemotron-3-ultra-free). Pinned models are exempt.
  const ranked: Array<{ key: string; rank: number; speed: number; vote: number }> = [];
  const modelRank = rankByModel(enabled);
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
    ranked.push({
      key: picked,
      rank: modelRank.get(canonicalModelId(modelId)) ?? meta?.intelligenceRank ?? Number.POSITIVE_INFINITY,
      speed: meta?.speedRank ?? 5,
      // Net 👍−👎 for this task kind — the tiebreak that lets feedback pick the preferred
      // model among equal peers. Zero without a stats store or any votes.
      vote: voteScore(taskKind, picked),
    });
  }
  // Tail order: speed class, then MODEL rank, then user feedback, then this row's speed (the
  // fastest gateway for a model leads its slower twins) — all from the catalog. Feedback sits
  // between rank and speed on purpose: a liked model leads its rank even if a peer is faster,
  // and a disliked one sinks to the rank's end, but a vote can NEVER skip a higher rank. A
  // speedRank-5 row (397B-class, a minute of prefill on a free gateway) stays in the pool as
  // a last resort but is never rotated into the head (2026-09-04: a chat turn took ~5 minutes
  // that way).
  const slowCapable = (e: { speed: number }): number => (e.speed >= 4 ? 1 : 0);
  ranked.sort((a, b) => slowCapable(a) - slowCapable(b) || a.rank - b.rank || b.vote - a.vote || a.speed - b.speed);
  // Quota-spreading among peers: rotate the head of each equal-rank, equal-speed, equal-vote
  // group so the NEXT turn leads with a different peer ("600 models, but it keeps using the
  // same 1-2"). Deterministic per taskKind via a counter — no RNG. Vote equals are required
  // for a peer group, otherwise rotating would scramble the feedback order.
  {
    const counter = nextTaskRound(taskKind);
    let i = 0;
    while (i < ranked.length) {
      const groupRank = ranked[i].rank;
      const groupSpeed = ranked[i].speed;
      const groupVote = ranked[i].vote;
      let j = i;
      // Peers = same model rank, same speed class AND same vote score, so rotation never
      // lifts a slower gateway above a faster one of the same quality, nor a disliked model
      // back above a liked one.
      while (j < ranked.length && ranked[j].rank === groupRank && ranked[j].speed === groupSpeed && ranked[j].vote === groupVote) j++;
      if (j - i > 1 && Number.isFinite(groupRank)) {
        const offset = counter % (j - i);          // 0..(groupSize-1)
        const rotated = [...ranked.slice(i, j).slice(offset), ...ranked.slice(i, j).slice(0, offset)];
        ranked.splice(i, j - i, ...rotated);
      }
      i = j;
    }
  }
  for (const r of ranked) {
    if (Number.isFinite(r.rank)) pickLabels.set(r.key, `enabled tail · intelligence rank ${r.rank}`);
    chain.push(r.key);
  }
  if (chain.length === 0) return keylessFallback();

  // "Why this model?" report: the chain in order (chain[0] = selected), then a BOUNDED sample
  // of skipped candidates — an unbounded list hit 361 entries and was re-posted every step.
  const rankOf = (key: string): number | undefined => {
    const platform = key.split('::')[0];
    const modelId = key.split('::').slice(1).join('::');
    const meta = sources?.catalog.find(platform, modelId);
    return meta && typeof meta.intelligenceRank === 'number' ? meta.intelligenceRank : undefined;
  };
  const MAX_SKIP_SHOWN = 15;
  const skipList = [...skipReasons.entries()]
    .filter(([key, reason]) => !chain.includes(key) && reason !== PROVIDER_OFF)
    .slice(0, MAX_SKIP_SHOWN);
  const rationale: SelectionRationale = {
    taskKind,
    picked: chain[0],
    entries: [
      ...chain.map((key, i) => {
        const rank = rankOf(key);
        const capability = rank !== undefined ? +((6 - rank) / 5).toFixed(2) : 0.5;
        const label = pickLabels.get(key) ?? 'enabled model';
        const vote = voteScore(taskKind, key);
        // The winner explains WHY it won: label, plus a "your feedback" tag when the user's
        // 👍/👎 actually moved it (rationaleForServed strips everything through the
        // "— serves this turn" tail, so the tag rides in the label half).
        const why = i === 0
          ? `${label}${vote !== 0 ? ` · your ${vote > 0 ? '👍' : '👎'} (score ${vote > 0 ? '+' : ''}${vote})` : ''} — serves this turn`
          : `${label} — failover #${i}`;
        return {
          model: key,
          selected: i === 0,
          score: capability, capability, runtime: 1, preference: 1, confidence: 0,
          reason: why,
          keyless: keylessOf(key),
        };
      }),
      ...skipList.map(([key, reason]) => ({
        model: key, selected: false, score: 0, capability: 0, runtime: 1, preference: 1, confidence: 0,
        reason, skip: reason,
        keyless: keylessOf(key),
      })),
    ],
  };
  // Report the bound (diag-visible, never in the popover) so the cap itself is auditable.
  const hiddenSkips = skipReasons.size - skipList.length;
  if (hiddenSkips > 0) diagLog('picker.rationale', `${chain.length} chained · ${skipList.length} of ${skipReasons.size} skips shown (${hiddenSkips} hidden)`);

  return { model: chain[0], fallbackChain: chain.slice(1), taskKind, rationale };
}

// Multi-provider router with automatic failover. Iterates the enabled fallback
// chain by priority; on a failover-able error (rate limit / transient / network
// / timeout / missing key) it advances to the next model. Non-streaming, so
// there is no mid-stream failover problem.
import type {
  ChatCompletionResponse,
  ChatMessage,
  CatalogModel,
  FallbackEntry,
  Platform,
} from '../shared/types';
import { ProviderHttpError } from '../providers/base';
import { resolveProvider } from '../providers';
import type { CompletionOptions } from '../providers/options';
import { fitMessages, inputBudget, estimateTokens, estimateMessagesTokens } from '../agent/budget';
import { orderForTask, type TaskKind } from '../agent/routing';
import type { SecretStore } from '../config/secrets';
import type { SettingsStore } from '../config/settingsStore';
import type { Catalog } from '../catalog/catalog';
import type { UsageTracker } from '../config/usage';
import type { UsageStore } from '../config/usageStore';
import type { ModelStatsStore } from '../config/modelStats';
import { RateTracker } from './rateTracker';
import { LatencyTracker } from './latencyTracker';

export interface RouteOptions extends CompletionOptions {
  /** Force a specific model (platform::modelId or 'auto'). */
  model?: string;
  /** Only consider tool-capable models (agent mode). */
  requireTools?: boolean;
  /** When the model is "Auto", order candidates by what this task needs. */
  taskKind?: TaskKind;
  /** Notified each time the router fails over to the next model. */
  onFailover?: (info: { from: FallbackEntry; reason: string }) => void;
  /** Notified when a 429 triggers a key rotation (same model, next key in pool). */
  onKeyRotated?: (info: { platform: Platform; keyIndex: number; keyTotal: number }) => void;
  /** Quality-based escalation: skip these `platform::modelId` keys (ones that underperformed). */
  exclude?: string[];
  /** Quality-based escalation: only consider models at least this smart (intelligenceRank <= this). */
  maxIntelligenceRank?: number;
  /**
   * Streaming text callback — called with each text delta as it arrives.
   * When provided the router uses streamChatCompletion instead of chatCompletion,
   * giving the user live token-by-token output instead of waiting for the full response.
   * Tool-call turns (where the model outputs JSON, not prose) are excluded — streaming
   * raw JSON fragments is not useful and confuses the UI.
   */
  onChunk?: (text: string) => void;
}

interface RouteResult {
  response: ChatCompletionResponse;
  platform: Platform;
  model: string;
  /** Runtime display name for custom endpoints (no-op for built-ins). */
  runtimeName?: string;
}

export class AllModelsFailedError extends Error {
  constructor(readonly failures: Array<{ platform: Platform; model: string; reason: string; detail?: string }>) {
    super(AllModelsFailedError.describe(failures));
    this.name = 'AllModelsFailedError';
  }

  private static describe(failures: Array<{ platform: Platform; model: string; reason: string; detail?: string }>): string {
    if (failures.length === 0) {
      return 'No enabled models are configured. Open "Manage Models & Keys" to enable a model and add an API key.';
    }
    // A lone failure is almost always a model the user explicitly forced — give
    // an actionable message (set a key / switch to Auto) instead of a code.
    if (failures.length === 1) {
      const f = failures[0];
      const who = `${f.platform}/${f.model}`;
      const isCustom = f.platform === 'custom';
      // The upstream's own words ("invalid model", "invalid api key", ...) — appended so a
      // misclassified failure (e.g. a 401 that's really a bad model id on a gateway that
      // auths-after-routing) is debuggable instead of a dead-end "update your key".
      const upstream = f.detail ? ` — endpoint said: ${f.detail}` : '';
      switch (f.reason) {
        case 'no_api_key': return `${who} needs an API key. Add one in "Manage Models & Keys", or set the model to Auto.`;
        case 'no_provider': return `${who} has no provider available. Pick another model, or set it to Auto.`;
        case 'not_found': return `${who} looks deprecated or removed by the provider${isCustom ? ' (or the model ID is wrong for this endpoint)' : ''}. Pick another model, or set it to Auto.${upstream}`;
        case 'rate_limited': return `${who} is rate-limited right now. Try again shortly, or set the model to Auto for automatic failover.`;
        case 'auth': return isCustom
          ? `${who} rejected the request (HTTP 401/403). Check the endpoint's API key, base URL, and model ID in "Manage Models & Keys".${upstream}`
          : `${who} rejected the API key. Update it in "Manage Models & Keys".${upstream}`;
        case 'bad_request': return `${who} rejected the request (HTTP 400)${isCustom ? ' — often a wrong model ID or unsupported parameter for this endpoint' : ''}.${upstream}`;
        case 'paid_only': return `${who} is paid-only or out of free quota on this provider (HTTP 402). Pick a different model, or set the model to Auto.`;
        default: return `${who} failed (${f.reason}). Try again, or set the model to Auto.${upstream}`;
      }
    }
    return `All ${failures.length} model(s) failed: ` + failures.map((f) => `${f.platform}/${f.model} (${f.reason})`).join(', ');
  }
}

function classify(err: unknown): { reason: string; failoverable: boolean; retryAfterMs?: number; detail?: string } {
  // The upstream's own error text (e.g. "invalid model", "invalid api key") — preserved so the
  // surfaced message can show what actually failed instead of only a canned reason. Critical for
  // custom endpoints, where "auth" might really be a bad model id or wrong base URL.
  const detail = err instanceof Error && err.message ? err.message : undefined;
  if (err instanceof ProviderHttpError) {
    const s = err.status;
    const retryAfterMs = err.retryAfterMs;
    if (s === 429) return { reason: 'rate_limited', failoverable: true, retryAfterMs, detail };
    if (s === 401 || s === 403) return { reason: 'auth', failoverable: true, detail };
    if (s === 408) return { reason: 'timeout', failoverable: true, detail };
    if (s === 413) return { reason: 'http_413', failoverable: true, detail };
    if (s === 404) return { reason: 'not_found', failoverable: true, detail };
    if (s === 400) return { reason: 'bad_request', failoverable: true, detail };
    // 402 Payment Required = the model is paid-only / out of free quota under
    // the user's current key. In AUTO mode, make it failoverable so the next
    // enabled model in the chain gets a chance. If ALL models 402, the error
    // surfaces as "All models exhausted" with the per-reason breakdown.
    if (s === 402) return { reason: 'paid_only', failoverable: true, detail };
    if (s && s >= 500) return { reason: 'server_error', failoverable: true, detail };
    return { reason: `http_${s ?? '?'}`, failoverable: true, detail };
  }
  // Network errors (fetch TypeError) and anything else: try the next model.
  return { reason: 'network', failoverable: true, detail };
}

export class Router {
  /** Last model (platform::modelId) that succeeded for each task kind — tried first next time. */
  private lastGood = new Map<TaskKind, string>();
  private rateTracker = new RateTracker();
  private latencyTracker = new LatencyTracker();
  /**
   * Per-model health cache — a circuit breaker with three effective states.
   * `ok` = closed (healthy). `bad` within its cooldown = open (skip without
   * trying). `bad` past its cooldown with no trial in flight = half-open
   * (computed, not stored — the next caller gets exactly one probe).
   * `failureStreak` grows the cooldown exponentially on repeated failures
   * (capped at `HEALTH_MAX_TTL_MS`) so a persistently broken model isn't
   * re-probed on every single call, while a single success resets it.
   */
  private health = new Map<string, { state: 'ok' | 'bad'; at: number; reason?: string; failureStreak: number; probing?: boolean }>();
  private static readonly HEALTH_BASE_TTL_MS = 60_000;
  private static readonly HEALTH_MAX_TTL_MS = 10 * 60_000;
  private static readonly PING_TIMEOUT_MS = 2000;

  constructor(
    private readonly secrets: SecretStore,
    private readonly settings: SettingsStore,
    private readonly catalog: Catalog,
    private readonly usage: UsageTracker,
    private readonly stats?: ModelStatsStore,
    private readonly usageStore?: UsageStore,
  ) {}

  /**
   * Pick a model for utility tasks (commit messages, titles) — short outputs where a
   * weak model embarrasses itself. Order: an explicit choice from settings →
   * strong KEYLESS models (the default, work with no API key) → curated strong keyed
   * models → the smartest model the user has → undefined (caller falls back to Auto).
   */
  async pickUtilityModel(): Promise<string | undefined> {
    const entries = this.settings.enabledByPriority();
    const enabled = new Set(entries.map((e) => `${e.platform}::${e.modelId}`));
    const pick = async (keys: string[]): Promise<string | undefined> => {
      for (const key of keys) {
        if (enabled.has(key) && (await this.isReady(key))) return key;
      }
      return undefined;
    };

    // 0. Explicit user choice (Settings → Others) wins when it's usable.
    const chosen = vscodeConfigString('tiermux.utilityModel', 'auto');
    if (chosen && chosen !== 'auto' && (await this.isReady(chosen))) return chosen;

    // 1. Strong KEYLESS models — the default, so titles/commits work with no API key.
    const keyless = await pick(['ovh::gpt-oss-120b', 'ovh::Meta-Llama-3_3-70B-Instruct', 'pollinations::openai-fast']);
    if (keyless) return keyless;

    // 2. Curated strong keyed models, if the user added a key.
    const keyed = await pick([
      'google::gemini-2.5-flash',
      'google::gemini-3.1-flash-lite',
      'groq::openai/gpt-oss-120b',
      'cerebras::gpt-oss-120b',
      'openrouter::deepseek/deepseek-chat-v3.1:free',
      'github::openai/gpt-4.1',
    ]);
    if (keyed) return keyed;

    // 3. The smartest model the user actually has.
    const ranked = entries
      .map((e) => ({ e, m: this.catalog.find(e.platform, e.modelId) }))
      .filter((x): x is { e: FallbackEntry; m: CatalogModel } => !!x.m)
      .sort((a, b) => (a.m.intelligenceRank + a.m.speedRank) - (b.m.intelligenceRank + b.m.speedRank));
    for (const { e } of ranked) {
      if (await this.isReady(`${e.platform}::${e.modelId}`)) return `${e.platform}::${e.modelId}`;
    }

    return undefined; // nothing keyed → caller falls back to Auto
  }

  /**
   * Check if a specific `platform::modelId` is ready to route to: enabled in
   * the fallback chain, not in rate-limit cooldown, and has an API key (or is
   * keyless). Used by short-task callers (commit messages, titles) to skip
   * models that would fail before trying them.
   */
  async isReady(fullKey: string): Promise<boolean> {
    const entries = this.settings.enabledByPriority();
    const [platform, ...rest] = fullKey.split('::');
    const modelId = rest.join('::');
    const entry = entries.find((e) => e.platform === platform && e.modelId === modelId);
    if (!entry || !entry.enabled) return false;
    if (this.secrets.cooldownRemaining(platform as Platform) > 0) return false;
    let key = await this.secrets.getModelKey(platform as Platform, modelId);
    if (!key) key = await this.secrets.resolveKey(platform as Platform);
    if (entry.key) key = entry.key;
    return key !== undefined;
  }

  /** A model's intelligence rank (lower = smarter); used by quality-based escalation. */
  intelligenceRankOf(platform: Platform, modelId: string): number | undefined {
    return this.catalog.find(platform, modelId)?.intelligenceRank;
  }

  /** Capability of the top-priority enabled model — used to decide weak-model scaffolding
   *  (core toolset, compact prompt, single-model path). Undefined if nothing is enabled. */
  topModelProfile(): { intelligenceRank: number; supportsReasoning: boolean } | undefined {
    const top = this.settings.enabledByPriority()[0];
    if (!top) return undefined;
    const m = this.catalog.find(top.platform, top.modelId);
    if (!m) return undefined;
    return { intelligenceRank: m.intelligenceRank, supportsReasoning: m.supportsReasoning };
  }

  private estimateComplexity(messages: ChatMessage[], taskKind?: string): 'simple' | 'complex' {
    if (taskKind === 'trivial') return 'simple';
    if (taskKind === 'agent' || taskKind === 'debug') return 'complex';
    // Long conversations or large messages indicate a complex task
    if (messages.length > 6 || estimateMessagesTokens(messages) > 800) return 'complex';
    return 'simple';
  }

  /** Build the ordered candidate list for a request. */
  private candidates(opts: RouteOptions): FallbackEntry[] {
    let list = this.settings.enabledByPriority();
    const forcedModel = !!(opts.model && opts.model !== 'auto');
    if (forcedModel) {
      const [platform, ...rest] = opts.model!.split('::');
      const modelId = rest.join('::');
      // Honor an explicit model pick EXACTLY: try only that model, never silently
      // substitute another. Falling over to a different model would contradict the
      // manual choice (the user picks Auto when they want failover). If it can't
      // run (no key, rate-limited, …) the caller surfaces a clear error instead.
      const forced = list.find((e) => e.platform === platform && e.modelId === modelId);
      return [forced ?? { platform: platform as Platform, modelId, enabled: true, priority: -1 }];
    }
    if (opts.requireTools) {
      // Skip models the catalog marks tool-incapable AND those quarantined at
      // runtime after rejecting a tools payload.
      list = list.filter(
        (e) =>
          this.catalog.find(e.platform, e.modelId)?.supportsTools !== false &&
          !this.secrets.isToolIncompatible(e.platform, e.modelId),
      );
    }
    // Drop models a provider has 404'd (deprecated/removed) so Auto never re-tries a
    // dead model — unless that would leave nothing, in which case keep them and let
    // the attempt surface a real error rather than silently doing nothing.
    const live = list.filter((e) => !this.secrets.isDeprecated(e.platform, e.modelId));
    if (live.length > 0) list = live;
    // Quality-based escalation (Auto only): drop models that already underperformed, and any
    // weaker than the floor, so a flaky weak model is replaced by a stronger one. If nothing
    // is left, route() surfaces AllModelsFailedError — the caller then recommends a free model.
    if (opts.exclude?.length) {
      const ex = new Set(opts.exclude);
      list = list.filter((e) => !ex.has(`${e.platform}::${e.modelId}`));
    }
    if (opts.maxIntelligenceRank != null) {
      const floor = opts.maxIntelligenceRank;
      list = list.filter((e) => {
        const m = this.catalog.find(e.platform, e.modelId);
        return !m || m.intelligenceRank <= floor;
      });
    }
    // Reorder by what the task needs (fast for chat, tool-capable+smart for
    // agent, etc.). Only Auto reaches here — a forced model returned above.
    if (opts.taskKind) {
      const kind = opts.taskKind;
      const score = this.stats ? (p: string, m: string): number => this.stats!.score(kind, p, m) : undefined;
      list = orderForTask(kind, list, this.catalog, score);
      // Fast path: lead with the model that last worked for this task kind, so we
      // don't re-walk the cascade each time — unless the user has downvoted it for
      // this task. (Filtered out below if it's cooling.)
      const good = this.lastGood.get(kind);
      if (good) {
        const i = list.findIndex((e) => `${e.platform}::${e.modelId}` === good);
        const notDisliked = !this.stats || this.stats.score(kind, list[i]?.platform, list[i]?.modelId) >= 0;
        if (i > 0 && notDisliked) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
      }
    }
    // Prefer platforms that aren't rate-limit-cooling. Never starve: if all are
    // cooling, fall back to the least-cooled order so we still attempt something.
    const ready = list.filter((e) => this.secrets.cooldownRemaining(e.platform) === 0);
    if (ready.length > 0) return ready;
    return [...list].sort(
      (a, b) => this.secrets.cooldownRemaining(a.platform) - this.secrets.cooldownRemaining(b.platform),
    );
  }

  private rateLimitCooldownMs(): number {
    return vscodeConfigNumber('tiermux.rateLimitCooldownMs', 60000);
  }

  private timeoutMs(): number {
    return vscodeConfigNumber('tiermux.requestTimeoutMs', 60000);
  }

  /** Per-provider floor: ZenMux and other queued free routers need more than the 60s default
   *  to survive cold starts; honor the provider's declared minimum so a user-tuned 60s setting
   *  doesn't accidentally cap a slow provider below what it needs. */
  private timeoutMsFor(provider: { timeoutMs?: number }): number {
    const floor = provider.timeoutMs ?? 0;
    return Math.max(this.timeoutMs(), floor);
  }

  /** Exponential cooldown for a given consecutive-failure streak, capped at `HEALTH_MAX_TTL_MS`. */
  private cooldownFor(failureStreak: number): number {
    return Math.min(Router.HEALTH_BASE_TTL_MS * 2 ** Math.max(0, failureStreak - 1), Router.HEALTH_MAX_TTL_MS);
  }

  /**
   * Per-model pre-flight health cache, used to skip a model we already know is down.
   * `'ok'` = closed. `'bad'` = open (skip). `'half-open'` = the failure cooldown has
   * elapsed and no trial is in flight yet — the caller may attempt exactly one probe.
   */
  private healthOf(platform: Platform, modelId: string): 'ok' | 'bad' | 'half-open' | undefined {
    const e = this.health.get(`${platform}::${modelId}`);
    if (!e) return undefined;
    if (e.state === 'ok') return 'ok';
    if (Date.now() - e.at <= this.cooldownFor(e.failureStreak)) return 'bad';
    if (e.probing) return 'bad'; // a trial is already in flight elsewhere — stay closed
    return 'half-open';
  }

  /** The cached probe reason for a model (auth/timeout/network/...), if any. */
  private cachedHealthReason(platform: Platform, modelId: string): string | undefined {
    return this.health.get(`${platform}::${modelId}`)?.reason;
  }

  private markHealth(platform: Platform, modelId: string, state: 'ok' | 'bad', reason?: string): void {
    const key = `${platform}::${modelId}`;
    if (state === 'ok') {
      this.health.set(key, { state: 'ok', at: Date.now(), failureStreak: 0 });
      return;
    }
    const prevStreak = this.health.get(key)?.failureStreak ?? 0;
    this.health.set(key, { state: 'bad', at: Date.now(), reason, failureStreak: prevStreak + 1 });
  }

  /** Claims the half-open trial for a model so concurrent route() calls don't pile on. */
  private markProbing(platform: Platform, modelId: string): void {
    const e = this.health.get(`${platform}::${modelId}`);
    if (e) e.probing = true;
  }

  /**
   * Tiny pre-flight: a 1-token `chat/completions` with a 5s timeout, used to
   * confirm the API key works and the model exists before sending the real
   * (potentially long) request. Succeeds fast on a healthy model, fails
   * fast on a dead one so failover feels instant. Result is cached with a
   * cooldown from `cooldownFor()`. Only runs the first time we try a model
   * in this window.
   */
  private async preflightPing(provider: ReturnType<typeof resolveProvider>, apiKey: string, platform: Platform, modelId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!provider) return { ok: false, reason: 'no_provider' };
    if (this.healthOf(platform, modelId) === 'ok') return { ok: true };
    const timeout = provider.preflightTimeoutMs ?? Router.PING_TIMEOUT_MS;
    try {
      await provider.ping(apiKey, modelId, timeout);
      this.markHealth(platform, modelId, 'ok');
      return { ok: true };
    } catch (err) {
      const { reason } = classify(err);
      this.markHealth(platform, modelId, 'bad', reason);
      return { ok: false, reason };
    }
  }

  async route(messages: ChatMessage[], opts: RouteOptions = {}): Promise<RouteResult> {
    const failures: Array<{ platform: Platform; model: string; reason: string; detail?: string }> = [];
    const maxOut = opts.max_tokens ?? 4096;
    // The tool manifest is appended to every request but isn't part of the
    // trimmed message list — reserve budget for it so we don't 413.
    const sentTools = !!(opts.tools && opts.tools.length);
    const toolsTokens = sentTools ? estimateTokens(JSON.stringify(opts.tools)) : 0;

    // Track which models we've tried and how many times
    const triedModels = new Map<string, number>();
    const MAX_RETRIES = 3;

    // Don't switch to a model that can't hold the conversation: prefer fallbacks
    // whose context window fits the current history (so a rate-limit hop doesn't
    // force trimming older turns). Only when the model is "Auto"; never starves.
    let cands = this.candidates(opts);
    const forced = !!(opts.model && opts.model !== 'auto');
    if (!forced && cands.length > 1) {
      const convoTokens = estimateMessagesTokens(messages);
      const fits = (e: FallbackEntry): boolean =>
        inputBudget(this.catalog.find(e.platform, e.modelId)?.contextWindow ?? 32768, maxOut, toolsTokens) >= convoTokens;
      const fitting = cands.filter(fits);
      if (fitting.length > 0 && fitting.length < cands.length) {
        cands = [...fitting, ...cands.filter((e) => !fits(e))];
      }

      // Complexity-aware latency preference.
      // Simple tasks (short messages, chat/trivial taskKind): within the same
      // intelligence tier (rank ±1), prefer whichever model has the lower p50
      // latency from real measurements. Complex tasks (agent/debug, long history)
      // keep the intelligence-first order that orderForTask already produced.
      const complexity = this.estimateComplexity(messages, opts.taskKind);
      if (complexity === 'simple') {
        cands = [...cands].sort((a, b) => {
          const ra = this.catalog.find(a.platform, a.modelId)?.intelligenceRank ?? 5;
          const rb = this.catalog.find(b.platform, b.modelId)?.intelligenceRank ?? 5;
          if (Math.abs(ra - rb) > 1) return 0; // different quality tiers — preserve order
          const la = this.latencyTracker.p50(a.platform, a.modelId) ?? Infinity;
          const lb = this.latencyTracker.p50(b.platform, b.modelId) ?? Infinity;
          return la - lb;
        });
      }
    }

    candidates: for (const entry of cands) {
      const modelKey = `${entry.platform}::${entry.modelId}`;
      const retryCount = triedModels.get(modelKey) || 0;

      // Skip if we've already tried this model MAX_RETRIES times
      if (retryCount >= MAX_RETRIES) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: `tried ${MAX_RETRIES} times` });
        continue;
      }

      const provider = resolveProvider(entry.platform, entry.modelId, this.settings.getCustomEndpoints());
      if (!provider) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: 'no_provider' });
        continue;
      }
      // Resolve the API key (check model-specific key first, then platform key)
      let apiKey = entry.key
        ?? await this.secrets.getModelKey(entry.platform, entry.modelId)
        ?? await this.secrets.resolveKey(entry.platform, entry.modelId);
      // Custom endpoints without a configured key are treated as missing (not keyless).
      // Empty-string keys from resolveKey happen when getCustomKey returns undefined.
      if (apiKey === undefined || (entry.platform === 'custom' && apiKey === '')) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: 'no_api_key' });
        continue;
      }

      // Pre-flight: skip models we recently learned are down (ping failed in
      // the last minute) so the user doesn't sit through a full request that
      // we already know will fail. Cached "ok" lets a known-healthy model
      // skip the probe entirely.
      if (retryCount === 0) {
        const cached = this.healthOf(entry.platform, entry.modelId);
        if (cached === 'bad' && !provider.skipPreflight) {
          // Surface the cached probe reason (auth/timeout/network/...) instead of
          // a generic 'preflight_failed' so the user knows what actually broke.
          const reason = this.cachedHealthReason(entry.platform, entry.modelId) ?? 'preflight_failed';
          failures.push({ platform: entry.platform, model: entry.modelId, reason });
          // Only signal failover when in Auto mode — forced models shouldn't show
          // "Routing to the best available model" since there's no actual routing.
          if (!forced) opts.onFailover?.({ from: entry, reason });
          continue;
        }
        if (cached === 'half-open' && !provider.skipPreflight) {
          this.markProbing(entry.platform, entry.modelId); // claim the trial before probing
        }
        if ((cached === undefined || cached === 'half-open') && !provider.skipPreflight) {
          const probe = await this.preflightPing(provider, apiKey, entry.platform, entry.modelId);
          if (!probe.ok) {
            failures.push({ platform: entry.platform, model: entry.modelId, reason: probe.reason ?? 'preflight_failed' });
            if (!forced) opts.onFailover?.({ from: entry, reason: probe.reason ?? 'preflight_failed' });
            continue;
          }
        }
      }

      const model: CatalogModel | undefined = this.catalog.find(entry.platform, entry.modelId);

      // Proactive rate-limit check: if we know this model's RPM/RPD limit and we've
      // already hit it this window, skip straight to the next model instead of waiting
      // for a 429 round-trip. Records every outbound attempt (below) so the window
      // stays accurate even across retries.
      if (model && !this.rateTracker.canSend(entry.platform, entry.modelId, model.rpmLimit, model.rpdLimit)) {
        const coolMs = this.rateTracker.rpmCooldownMs(entry.platform, entry.modelId, model.rpmLimit);
        failures.push({ platform: entry.platform, model: entry.modelId, reason: `rpm_limit (${Math.ceil(coolMs / 1000)}s cooldown)` });
        if (!forced) opts.onFailover?.({ from: entry, reason: 'rpm_limit' });
        continue;
      }

      const completionOpts: CompletionOptions = {
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        top_p: opts.top_p,
        tools: opts.tools,
        tool_choice: opts.tool_choice,
        parallel_tool_calls: opts.parallel_tool_calls,
        reasoningEffort: model?.supportsReasoning ? opts.reasoningEffort : undefined,
        baseUrlOverride: this.settings.getEndpoint(entry.platform),
        timeoutMs: opts.timeoutMs ?? this.timeoutMsFor(provider as { timeoutMs?: number }),
      };

      let reserved = toolsTokens;
      let triedTrim = false;
      for (;;) {
        // Trim the conversation to fit this model's context window.
        const fitted = fitMessages(messages, inputBudget(model?.contextWindow, maxOut, reserved)).messages;
        try {
          let response: ChatCompletionResponse;
          // Stream when: caller wants live chunks AND this is a text-answer turn (no tools).
          // Tool-call turns produce JSON fragments, not prose — streaming them is useless and
          // would send partial JSON to onChunk, confusing the UI. The agent already knows
          // which turns need tools vs. which produce the final answer.
          // Record this attempt in the rate tracker BEFORE the HTTP call so the
          // window stays accurate even if the request errors.
          this.rateTracker.record(entry.platform, entry.modelId);
          const t0 = Date.now();

          const wantsStream = !!(opts.onChunk && !opts.tools?.length);
          if (wantsStream) {
            const chunks: string[] = [];
            let toolCalls: import('../shared/types').ChatToolCall[] | undefined;
            for await (const chunk of provider.streamChatCompletion(apiKey, fitted, entry.modelId, completionOpts)) {
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) {
                chunks.push(delta.content);
                opts.onChunk!(delta.content);
              }
              if (delta.tool_calls?.length) toolCalls = delta.tool_calls;
            }
            const fullText = chunks.join('');
            // Most providers don't emit `usage` in their SSE chunks (would need
            // `stream_options.include_usage` set on the request, which the OpenAI
            // stream spec supports but not every free provider honors). Until the
            // request body opts in, estimate the counts from the data we DO have:
            // the fitted messages we actually sent (prompt) and the assembled
            // text we received (completion). Same heuristic the rest of the router
            // uses for context-fit pre-checks (`estimateMessagesTokens(messages)`
            // at line 347), so the session and lifetime counters stay consistent
            // with the budget logic.
            const promptTokens = estimateMessagesTokens(fitted);
            const completionTokens = estimateTokens(fullText);
            response = {
              id: `chatcmpl-stream-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: entry.modelId,
              choices: [{ index: 0, message: { role: 'assistant', content: fullText, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: 'stop' }],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
            };
          } else {
            response = await provider.chatCompletion(apiKey, fitted, entry.modelId, completionOpts);
          }

          // Empty response (no text, no tool calls): treat as failure and failover.
          // Some misconfigured endpoints return HTTP 200 with empty content — don't
          // accept that as a successful answer when better models are available.
          const responseContent = response.choices?.[0]?.message?.content;
          const hasToolCalls = !!(response.choices?.[0]?.message?.tool_calls?.length);
          if (!forced && !responseContent && !hasToolCalls) {
            this.markHealth(entry.platform, entry.modelId, 'bad', 'empty_response');
            this.secrets.setStatus(entry.platform, 'error');
            failures.push({ platform: entry.platform, model: entry.modelId, reason: 'empty_response' });
            opts.onFailover?.({ from: entry, reason: 'empty_response' });
            continue candidates;
          }

          this.latencyTracker.record(entry.platform, entry.modelId, Date.now() - t0);
          this.usage.add(response.usage);
          this.usageStore?.addRequest(response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0);
          this.secrets.setStatus(entry.platform, 'healthy');
          this.markHealth(entry.platform, entry.modelId, 'ok');
          // Remember the winner so the next same-kind task starts here, not at the top of the cascade.
          if (opts.taskKind) this.lastGood.set(opts.taskKind, `${entry.platform}::${entry.modelId}`);
          return { response, platform: entry.platform, model: entry.modelId, runtimeName: (provider as any).runtimeName };
        } catch (err) {
          const { reason, failoverable, retryAfterMs, detail } = classify(err);

          // Payload too large with tools: retry this same model once with a
          // tighter budget before failing over.
          if (reason === 'http_413' && sentTools && !triedTrim) {
            triedTrim = true;
            reserved = toolsTokens * 2 + 1024;
            continue;
          }

          if (reason === 'rate_limited') {
            // Cool just this key, then check if another key is available for
            // the same platform before failing over to the next model.
            this.secrets.setCooldownForKey(apiKey, retryAfterMs ?? this.rateLimitCooldownMs());
            const allKeys = await this.secrets.getKeys(entry.platform);
            const nextKey = allKeys.find((k) => this.secrets.keyCooldownRemaining(k) === 0);
            if (nextKey !== undefined && nextKey !== apiKey) {
              opts.onKeyRotated?.({ platform: entry.platform, keyIndex: allKeys.indexOf(nextKey) + 1, keyTotal: allKeys.length });
              apiKey = nextKey;
              triedTrim = false;
              continue;
            }
            // All keys for this platform are cooled — cool the platform itself.
            this.secrets.setCooldown(entry.platform, retryAfterMs ?? this.rateLimitCooldownMs());

            // Pinned model: wait for the cooldown and retry the SAME model (up to MAX_RETRIES).
            // This handles per-second / short-window rate limits transparently without failing over.
            if (forced && retryCount < MAX_RETRIES) {
              const waitMs = Math.min(retryAfterMs ?? this.rateLimitCooldownMs(), 15_000);
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              triedModels.set(modelKey, retryCount + 1);
              continue;
            }
          } else if (reason === 'auth') {
            this.secrets.setStatus(entry.platform, 'invalid');
          } else {
            this.secrets.setStatus(entry.platform, 'error');
          }

          // A model that advertises tools but rejects the tools payload gets
          // quarantined so requireTools routing skips it next time.
          if (sentTools && (reason === 'bad_request' || reason === 'http_413')) {
            this.secrets.markToolIncompatible(entry.platform, entry.modelId);
          }

          // A 404 means the model is gone/deprecated (catalog entries go stale).
          // Quarantine it so Auto stops trying it and the picker can flag it.
          if (reason === 'not_found') {
            this.secrets.markDeprecated(entry.platform, entry.modelId);
          }

          // Cache the failure so the next call within TTL skips straight to
          // the next model (no preflight ping, no full request).
          this.markHealth(entry.platform, entry.modelId, 'bad', reason);

          // Increment the retry count for this model
          triedModels.set(modelKey, retryCount + 1);

          failures.push({ platform: entry.platform, model: entry.modelId, reason, detail });
          // Only signal failover when in Auto mode — forced models shouldn't show
          // "Routing to the best available model" since there's no actual routing.
          if (!forced) opts.onFailover?.({ from: entry, reason });
          if (!failoverable || forced) break candidates;
          continue candidates;
        }
      }
    }
    throw new AllModelsFailedError(failures);
  }
}

// Late-bound to avoid importing vscode at module-eval time in non-extension tests.
function vscodeConfigNumber(key: string, fallback: number): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as typeof import('vscode');
    const dot = key.lastIndexOf('.');
    return vscode.workspace.getConfiguration(key.slice(0, dot)).get<number>(key.slice(dot + 1), fallback);
  } catch {
    return fallback;
  }
}

function vscodeConfigString(key: string, fallback: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as typeof import('vscode');
    const dot = key.lastIndexOf('.');
    return vscode.workspace.getConfiguration(key.slice(0, dot)).get<string>(key.slice(dot + 1), fallback);
  } catch {
    return fallback;
  }
}

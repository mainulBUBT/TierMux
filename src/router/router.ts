

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
import { contentToString } from '../agent/content';
import { diagLog } from '../util/diag';
import { VISION_BLIND } from '../agent/answerQuality';
import type { SecretStore } from '../config/secrets';
import type { SettingsStore } from '../config/settingsStore';
import type { Catalog } from '../catalog/catalog';
import type { UsageTracker } from '../config/usage';
import type { UsageStore } from '../config/usageStore';
import type { ModelStatsStore } from '../config/modelStats';
import type { SlowModelStore } from '../config/slowModel';
import { SLOW_LATENCY_MS } from '../config/slowModel';
import { RateTracker } from './rateTracker';
import { LatencyTracker } from './latencyTracker';
import type { MetricsStore, MetricSample } from './metricsStore';
import { ScoringEngine, type SelectionContext, type HealthState, type RationaleEntry, type CandidateRuntime } from './scoring';
import type { FailureType } from './scoringConfig';
import { SCORING_CONFIG } from './scoringConfig';

/** Smart Auto scoring toggle (module-level mutable, wired from settings — the chatHedging pattern). */
let smartScoringEnabled = true;
export function setSmartScoring(on: boolean): void {
  smartScoringEnabled = on;
}

/** Map a classified route `reason` (+ whether tools were sent) to a metrics FailureType. */
function toFailureType(reason: string, sentTools: boolean): FailureType {
  if (reason === 'rate_limited') return 'http_429';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'network') return 'connection_refused';
  if (reason === 'server_error') return 'http_5xx';
  if (reason === 'http_413') return sentTools ? 'tool_unsupported' : 'context_too_large';
  if (reason === 'bad_request') return sentTools ? 'tool_unsupported' : 'bad_request';
  return 'other';
}

/**
 * Streaming `<think>…</think>` stripper. Buffers incoming deltas and emits only
 * the non-reasoning text. Handles tags that span multiple chunks, dangling
 * opening tags (incomplete at stream end), and nested/multiple think blocks.
 *
 * Some models (Qwen3, DeepSeek-R1, etc.) emit reasoning inside `<think>` tags
 * directly in the content stream. Without stripping, the client sees the raw
 * reasoning markup alongside the actual answer.
 */
export class ThinkStripper {
  private buf = '';
  private insideThink = false;

  feed(delta: string): string {
    this.buf += delta;
    let out = '';

    while (this.buf.length > 0) {
      if (this.insideThink) {
        const closeIdx = this.buf.toLowerCase().indexOf('</think>');
        if (closeIdx === -1) {

          break;
        }

        this.buf = this.buf.slice(closeIdx + '</think>'.length);
        this.insideThink = false;
        continue;
      }

      const openIdx = this.buf.toLowerCase().indexOf('<think>');
      if (openIdx === -1) {

        const holdBack = Math.min(6, this.buf.length);

        const prefix = '<think>';
        let safeUpTo = this.buf.length;
        for (let i = this.buf.length - holdBack + 1; i <= this.buf.length; i++) {
          const tail = this.buf.slice(i - 1).toLowerCase();
          if (prefix.startsWith(tail)) {
            safeUpTo = Math.min(safeUpTo, i - 1);
          }
        }
        out += this.buf.slice(0, safeUpTo);
        this.buf = this.buf.slice(safeUpTo);
        break;
      }

      out += this.buf.slice(0, openIdx);
      this.buf = this.buf.slice(openIdx + '<think>'.length);
      this.insideThink = true;
    }

    return out;
  }

  /** Flush any remaining buffer at stream end. If we're still inside a `<think>`,
   *  the tag was dangling — discard the buffered reasoning. Otherwise emit
   *  any held-back text. */
  flush(): string {
    if (this.insideThink) {
      this.buf = '';
      this.insideThink = false;
      return '';
    }
    const remaining = this.buf;
    this.buf = '';
    return remaining;
  }
}

/** Strip `<think>…</think>` from a complete (non-streamed) response string. */
export function stripThinkTags(text: string): string {
  let result = text;

  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');

  result = result.replace(/<think>[\s\S]*$/i, '');
  return result.trim();
}

/**
 * Extract a reasoning/thinking delta from a streamed chunk's `delta`. Providers disagree on the
 * field: DeepSeek/OpenRouter use `reasoning_content`, some send `reasoning`, and OpenAI/OpenCode
 * Zen send an array `reasoning_details` of `{ type: 'reasoning.text', text }`. Returns '' if the
 * chunk carries no reasoning.
 */
function reasoningFromDelta(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning === 'string' && delta.reasoning) return delta.reasoning;
  const details = delta.reasoning_details;
  if (Array.isArray(details)) {
    let out = '';
    for (const d of details) {
      const t = (d as { text?: unknown }).text;
      if (typeof t === 'string') out += t;
    }
    if (out) return out;
  }
  return '';
}

export interface RouteOptions extends CompletionOptions {
  /** Force a specific model (platform::modelId or 'auto'). */
  model?: string;
  /** Only consider tool-capable models (agent mode). */
  requireTools?: boolean;
  /** When the model is "Auto", order candidates by what this task needs. */
  taskKind?: TaskKind;
  /** True when the turn carries a raw PDF `file` block (extraction produced no text, so
   *  the raw bytes are the only way a model can read it) — steers Auto away from models
   *  the catalog marks `rejectsRawPdf`. See CatalogModel.rejectsRawPdf. */
  hasRawPdfPart?: boolean;
  /** Notified each time the router fails over to the next model. */
  onFailover?: (info: { from: FallbackEntry; reason: string }) => void;
  /** Notified when a 429 triggers a key rotation (same model, next key in pool). */
  onKeyRotated?: (info: { platform: Platform; keyIndex: number; keyTotal: number }) => void;
  /** Notified once per route() with the per-model scoring rationale (why selected / why not). */
  onSelectionRationale?: (info: {
    taskKind: TaskKind;
    picked?: FallbackEntry;
    rationale: import('./scoring').RationaleEntry[];
  }) => void;
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
  /** Live reasoning/thinking tokens streamed by reasoning models (big-pickle, qwen3, glm, …).
   *  Many providers put the actual output in `reasoning_content` / `reasoning` while `content`
   *  stays empty; without this channel those turns render blank (0 tokens, no answer). */
  onReasoning?: (text: string) => void;
  /** Profiler: notified per provider attempt (ok or fail). Not emitted for preflight skips. */
  onProviderAttempt?: (info: { platform: string; model: string; status: 'ok' | 'fail'; latencyMs: number; errorType?: string; reason?: string }) => void;
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

    if (failures.length === 1) {
      const f = failures[0];
      const who = `${f.platform}/${f.model}`;
      const isCustom = f.platform === 'custom';

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

/**
 * Thrown when a message carries a visual attachment (an image, or a PDF whose
 * text couldn't be extracted) but no enabled model is vision-capable. Better to
 * stop here with an actionable message than to send a turn a text-only model can
 * never fulfill — the model would just refuse ("I can't read this PDF") after
 * burning a request. See candidates(): the vision filter keys off taskKind==='vision'.
 */
export class NoVisionModelError extends Error {
  constructor() {
    super(
      'This message has an image or PDF attachment, but none of your enabled models can read attachments. ' +
      'Open "Manage Models & Keys" and enable a vision-capable model (e.g. Gemini, GPT-4o, Claude) to read it.',
    );
    this.name = 'NoVisionModelError';
  }
}

function classify(err: unknown): { reason: string; failoverable: boolean; retryAfterMs?: number; detail?: string } {

  const detail = err instanceof Error && err.message ? err.message : undefined;
  if (err instanceof ProviderHttpError) {
    const s = err.status;
    // Retry-After isn't always an HTTP header — Groq/OpenRouter/Cohere put it in the body
    // ("try again in 35.64s", "retry after 30 seconds"). Fall back to parsing the body text so
    // the wait+retry honors the real cooldown for every provider, not just header-senders.
    const retryAfterMs = err.retryAfterMs ?? (s === 429 && detail ? parseRetryFromBody(detail) : undefined);
    if (s === 429) return { reason: 'rate_limited', failoverable: true, retryAfterMs, detail };
    if (s === 401 || s === 403) return { reason: 'auth', failoverable: true, detail };
    if (s === 408) return { reason: 'timeout', failoverable: true, detail };
    if (s === 413) return { reason: 'http_413', failoverable: true, detail };
    if (s === 404) return { reason: 'not_found', failoverable: true, detail };
    if (s === 400) return { reason: 'bad_request', failoverable: true, detail };

    if (s === 402) return { reason: 'paid_only', failoverable: true, detail };
    if (s && s >= 500) return { reason: 'server_error', failoverable: true, detail };
    return { reason: `http_${s ?? '?'}`, failoverable: true, detail };
  }

  return { reason: 'network', failoverable: true, detail };
}

/**
 * Extract a retry-after duration from an error body, since many providers omit the HTTP
 * `Retry-After` header and state the cooldown in prose: "try again in 35.64s", "retry after
 * 30 seconds", "retry-after: 60", "please wait 2 minutes". Returns ms, or undefined.
 */
function parseRetryFromBody(text: string): number | undefined {
  const re = /(?:try again|retry[^a-z]*(?:after|in)|wait)[^0-9]*([\d.]+)\s*(ms|millis(?:econds?)?|s|sec(?:onds?)?|m|min(?:utes?)?)/i;
  const m = re.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('ms')) return n;
  if (unit.startsWith('s')) return n * 1000;
  return n * 60_000; // minutes
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
    private readonly slowModels?: SlowModelStore,
    private readonly metrics?: MetricsStore,
    private readonly scoring?: ScoringEngine,
  ) {}

  private smartScoringActive(): boolean {
    return smartScoringEnabled && !!this.scoring && !!this.metrics;
  }

  /** Optional dev trace sink — fired once per route() with the scoring rationale. */
  private rationaleSink?: (info: { taskKind: TaskKind; rationale: RationaleEntry[] }) => void;
  setRationaleSink(fn: ((info: { taskKind: TaskKind; rationale: RationaleEntry[] }) => void) | undefined): void {
    this.rationaleSink = fn;
  }

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

    const chosen = vscodeConfigString('tiermux.utilityModel', 'auto');
    if (chosen && chosen !== 'auto' && (await this.isReady(chosen))) return chosen;

    const keyless = await pick(['ovh::gpt-oss-120b', 'ovh::Meta-Llama-3_3-70B-Instruct', 'pollinations::openai-fast']);
    if (keyless) return keyless;

    const keyed = await pick([
      'google::gemini-2.5-flash',
      'groq::openai/gpt-oss-120b',
      'cerebras::gpt-oss-120b',
      'openrouter::deepseek/deepseek-chat-v3.1:free',
      'github::openai/gpt-4.1',
    ]);
    if (keyed) return keyed;

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

  /** Record a whole-turn quality outcome against a model's per-taskKind reliability. The
   *  agent layer calls this when a turn HTTP-succeeded but produced no usable answer (empty
   *  after a long tool loop) — the per-completion metrics count every tool-call round as a
   *  success and would otherwise never learn that the turn as a whole failed. `totalMs` is
   *  the turn wall-clock, so a slow burn also dents the speed signal. */
  noteTurnOutcome(platform: Platform, modelId: string, taskKind: TaskKind, ok: boolean, totalMs: number): void {
    this.metrics?.record(platform, modelId, taskKind, {
      ok, failureType: ok ? undefined : 'other', totalMs: Math.max(0, totalMs), rateLimited: false,
    });
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

    if (messages.length > 6 || estimateMessagesTokens(messages) > 800) return 'complex';
    return 'simple';
  }

  /**
   * Gather the synchronous runtime facts per candidate that the scoring engine
   * needs (health, rate-availability, capability). Key resolution is deliberately
   * NOT done here (it can prompt); the try-loop remains the authoritative gate
   * for missing keys, so `hasKey` defaults optimistic.
   */
  private buildSelectionContext(kind: TaskKind, entries: FallbackEntry[], opts: RouteOptions): SelectionContext {
    const runtime = new Map<string, CandidateRuntime>();
    const loadByPlatform = new Map<string, number>();
    for (const e of entries) {
      const m = this.catalog.find(e.platform, e.modelId);
      const h = this.healthOf(e.platform, e.modelId);
      const health: HealthState = h === 'bad' ? 'bad' : h === 'half-open' ? 'half-open' : 'ok';
      const canSend = m ? this.rateTracker.canSend(e.platform, e.modelId, m.rpmLimit, m.rpdLimit) : true;
      const headroom = m ? this.rateTracker.headroom(e.platform, e.modelId, m.rpmLimit, m.rpdLimit) : 1;
      // Per-platform, so cache it — recentLoad scans every tracked key.
      let providerLoad = loadByPlatform.get(e.platform);
      if (providerLoad === undefined) {
        providerLoad = this.rateTracker.recentLoad(e.platform);
        loadByPlatform.set(e.platform, providerLoad);
      }
      const capable = opts.requireTools
        ? m?.supportsTools !== false && !this.secrets.isToolIncompatible(e.platform, e.modelId)
        : kind === 'vision'
          ? !!m?.supportsVision
          : true;
      runtime.set(`${e.platform}::${e.modelId}`, { health, canSend, hasKey: true, capable, headroom, providerLoad });
    }
    return { taskKind: kind, entries, runtime, requireTools: !!opts.requireTools, isVision: kind === 'vision' };
  }

  /**
   * Baseline-relative slow labeling (replaces the fixed 8s rule). A model is slow
   * only when a response runs well above its OWN historical baseline with enough
   * samples to trust the comparison — so "Laguna is always 30s" isn't penalized,
   * but "Groq is 20s tonight" is. Falls back to the legacy fixed threshold when
   * the metrics store isn't present or a model has no baseline yet.
   */
  private maybeMarkSlow(platform: Platform, modelId: string, kind: TaskKind, totalMs: number, ttftMs?: number): void {
    if (!this.slowModels) return;
    if (!this.metrics) {
      if (totalMs >= SLOW_LATENCY_MS) this.slowModels.markSlow(platform, modelId);
      return;
    }
    const agg = this.metrics.modelAgg(platform, modelId, kind);
    if (!agg || this.metrics.sampleCount(agg) < SCORING_CONFIG.minSamples) return;
    const base = this.metrics.ttftBaseline(agg) || this.metrics.totalBaseline(agg);
    if (base > 0 && (ttftMs ?? totalMs) > base * SCORING_CONFIG.driftMultiplier) {
      this.slowModels.markSlow(platform, modelId);
    }
  }

  /** Build the ordered candidate list for a request. */
  private candidates(opts: RouteOptions): FallbackEntry[] {
    let list = this.settings.enabledByPriority();
    const forcedModel = !!(opts.model && opts.model !== 'auto');
    if (forcedModel) {
      const [platform, ...rest] = opts.model!.split('::');
      const modelId = rest.join('::');

      const forced = list.find((e) => e.platform === platform && e.modelId === modelId);
      diagLog('router.candidates', `forced model="${opts.model}" → platform=${platform} modelId=${modelId} foundInCatalog=${!!forced}`);
      return [forced ?? { platform: platform as Platform, modelId, enabled: true, priority: -1 }];
    }
    if (opts.requireTools) {

      list = list.filter(
        (e) =>
          this.catalog.find(e.platform, e.modelId)?.supportsTools !== false &&
          !this.secrets.isToolIncompatible(e.platform, e.modelId),
      );
    }

    const live = list.filter((e) => !this.secrets.isDeprecated(e.platform, e.modelId));
    if (live.length > 0) list = live;

    if (opts.taskKind === 'vision') {
      const visionCapable = list.filter((e) => this.catalog.find(e.platform, e.modelId)?.supportsVision);
      if (visionCapable.length === 0) throw new NoVisionModelError();
      list = visionCapable;

      // A flattenContent provider (e.g. Cohere's compat endpoint) reduces multimodal
      // content to plain text on the wire — the image never reaches the model, so for a
      // vision turn such entries are vision-capable in name only. Prefer providers that
      // can actually carry the image; keep the flatteners only as a last resort.
      const carriesImages = list.filter((e) => {
        const p = resolveProvider(e.platform, e.modelId, this.settings.getCustomEndpoints());
        return !(p as { flattenContent?: boolean } | undefined)?.flattenContent;
      });
      if (carriesImages.length > 0) list = carriesImages;

      if (opts.hasRawPdfPart) {
        const acceptsRawPdf = list.filter((e) => !this.catalog.find(e.platform, e.modelId)?.rejectsRawPdf);
        if (acceptsRawPdf.length > 0) list = acceptsRawPdf;
      }
    }

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

    if (opts.taskKind) {
      const kind = opts.taskKind;
      const score = this.stats ? (p: string, m: string): number => this.stats!.score(kind, p, m) : undefined;
      list = orderForTask(kind, list, this.catalog, score);

      const good = this.lastGood.get(kind);
      if (good) {
        const i = list.findIndex((e) => `${e.platform}::${e.modelId}` === good);
        const notDisliked = !this.stats || this.stats.score(kind, list[i]?.platform, list[i]?.modelId) >= 0;
        // A lastGood pin must not resurrect a model currently flagged slow — "it answered"
        // is not "it answered acceptably fast", and the pin otherwise self-renews forever
        // (each slow success re-writes lastGood, so the same 200s+ model wins every turn).
        const notSlow = i < 0 || !this.slowModels?.isSlow(list[i].platform, list[i].modelId);
        if (i > 0 && notDisliked && notSlow) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
      }
    }

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

    const sentTools = !!(opts.tools && opts.tools.length);
    const toolsTokens = sentTools ? estimateTokens(JSON.stringify(opts.tools)) : 0;

    const triedModels = new Map<string, number>();
    // One retry, not three: a rate-limited free model rarely recovers within a single turn's
    // patience, so a second wait+retry is usually just dead latency. After one attempt, move on
    // (fail over in Auto, or surface the error for a pinned model).
    const MAX_RETRIES = 1;

    let cands = this.candidates(opts);
    const forced = !!(opts.model && opts.model !== 'auto');
    // Set when Smart Auto scoring ran, so the eventual winning candidate can be checked against
    // the rationale reported below — the rationale reflects the ranking's top pick BEFORE the
    // candidates loop tries anything; if that pick fails (health/rate-limit/empty response/error)
    // and a lower-ranked candidate ends up serving the request, the UI must not keep showing the
    // original top pick as "selected". See the `pickedRank` correction at the loop's success path.
    let pickedRank: { taskKind: TaskKind; rationale: import('./scoring').RationaleEntry[]; top: FallbackEntry } | undefined;
    if (!forced && cands.length > 1) {
      // Context-window fit is a hard constraint in both modes — fitting models first.
      const convoTokens = estimateMessagesTokens(messages);
      const fits = (e: FallbackEntry): boolean =>
        inputBudget(this.catalog.find(e.platform, e.modelId)?.contextWindow ?? 32768, maxOut, toolsTokens) >= convoTokens;
      const fitting = cands.filter(fits);
      if (fitting.length > 0 && fitting.length < cands.length) {
        cands = [...fitting, ...cands.filter((e) => !fits(e))];
      }

      if (this.smartScoringActive() && opts.taskKind) {
        // Smart Auto: learned Capability × Runtime × Preference scoring subsumes the
        // legacy latency-sort, slow-deprioritization, and lastGood heuristics.
        const ctx = this.buildSelectionContext(opts.taskKind, cands, opts);
        const rank = this.scoring!.rank(ctx);
        cands = rank.ordered;
        pickedRank = { taskKind: opts.taskKind, rationale: rank.rationale, top: rank.ordered[0] };
        opts.onSelectionRationale?.({ taskKind: opts.taskKind, picked: rank.ordered[0], rationale: rank.rationale });
        this.rationaleSink?.({ taskKind: opts.taskKind, rationale: rank.rationale });
      } else {
        const complexity = this.estimateComplexity(messages, opts.taskKind);
        if (complexity === 'simple') {
          cands = [...cands].sort((a, b) => {
            const ra = this.catalog.find(a.platform, a.modelId)?.intelligenceRank ?? 5;
            const rb = this.catalog.find(b.platform, b.modelId)?.intelligenceRank ?? 5;
            if (Math.abs(ra - rb) > 1) return 0; // different quality tiers — preserve order
            const la = this.latencyTracker.p50(a.platform, a.modelId);
            const lb = this.latencyTracker.p50(b.platform, b.modelId);
            // No p50 yet (< 3 samples) → keep catalog order rather than sinking the unsampled
            // model to the bottom — treating "unmeasured" as "slowest" meant a fresh fast model
            // could never earn samples while a measured-slow one kept winning.
            if (la == null || lb == null) return 0;
            return la - lb;
          });
        }

        if (this.slowModels) {
          const notSlow = cands.filter((e) => !this.slowModels!.isSlow(e.platform, e.modelId));
          const slow = cands.filter((e) => this.slowModels!.isSlow(e.platform, e.modelId));
          if (slow.length > 0 && notSlow.length > 0) cands = [...notSlow, ...slow];
        }
      }
    }

    candidates: for (const entry of cands) {
      const modelKey = `${entry.platform}::${entry.modelId}`;
      const retryCount = triedModels.get(modelKey) || 0;

      if (retryCount >= MAX_RETRIES) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: `tried ${MAX_RETRIES} times` });
        continue;
      }

      const provider = resolveProvider(entry.platform, entry.modelId, this.settings.getCustomEndpoints());
      if (!provider) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: 'no_provider' });
        opts.onProviderAttempt?.({ platform: entry.platform, model: entry.modelId, status: 'fail', latencyMs: 0, errorType: 'not_found', reason: 'no_provider' });
        continue;
      }

      let apiKey = entry.key
        ?? await this.secrets.getModelKey(entry.platform, entry.modelId)
        ?? await this.secrets.resolveKey(entry.platform, entry.modelId);

      if (apiKey === undefined || (entry.platform === 'custom' && apiKey === '')) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: 'no_api_key' });
        continue;
      }

      if (retryCount === 0) {
        const cached = this.healthOf(entry.platform, entry.modelId);
        if (cached === 'bad' && !provider.skipPreflight) {

          const reason = this.cachedHealthReason(entry.platform, entry.modelId) ?? 'preflight_failed';
          failures.push({ platform: entry.platform, model: entry.modelId, reason });

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

        const fitted = fitMessages(messages, inputBudget(model?.contextWindow, maxOut, reserved)).messages;
        const t0 = Date.now();
        try {
          let response: ChatCompletionResponse;

          this.rateTracker.record(entry.platform, entry.modelId);

          const wantsStream = !!opts.onChunk;
          let firstChunkAt: number | null = null; // TTFT — time to first emitted content
          if (wantsStream) {
            const chunks: string[] = [];
            const reasoningChunks: string[] = [];
            // OpenAI-wire tool_call deltas arrive fragmented across chunks, keyed by `index`:
            // the first fragment carries id/name, later ones carry only incremental `arguments`
            // slices — they must be merged, not overwritten, or the accumulated JSON is corrupt.
            const toolCallsByIndex = new Map<number, import('../shared/types').ChatToolCall>();
            let finalUsage: import('../shared/types').TokenUsage | undefined;
            const thinkStrip = new ThinkStripper();
            for await (const chunk of provider.streamChatCompletion(apiKey, fitted, entry.modelId, completionOpts)) {
              if (chunk.usage) finalUsage = chunk.usage;
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) {
                const clean = thinkStrip.feed(delta.content);
                if (clean) {
                  if (firstChunkAt === null) firstChunkAt = Date.now();
                  chunks.push(clean);
                  opts.onChunk!(clean);
                }
              }
              // Reasoning models stream their real output in reasoning channels while `content`
              // is empty or lags behind. Capture every variant so the turn isn't silently blank.
              const rDelta = reasoningFromDelta(delta as Record<string, unknown>);
              if (rDelta) {
                reasoningChunks.push(rDelta);
                opts.onReasoning?.(rDelta);
              }
              for (const [pos, tcDelta] of (delta.tool_calls ?? []).entries()) {
                // Real OpenAI-wire streams fragment one call per chunk with an explicit `index`;
                // providers that fake streaming as a single chunk (e.g. Google) omit it and send
                // the full array at once, so fall back to array position, not a shared 0.
                const idx = (tcDelta as unknown as { index?: number }).index ?? pos;
                const existing = toolCallsByIndex.get(idx);
                if (!existing) {
                  toolCallsByIndex.set(idx, {
                    id: tcDelta.id ?? `call_${idx}`,
                    type: 'function',
                    function: { name: tcDelta.function?.name ?? '', arguments: tcDelta.function?.arguments ?? '' },
                  });
                } else {
                  if (tcDelta.id) existing.id = tcDelta.id;
                  if (tcDelta.function?.name) existing.function.name = tcDelta.function.name;
                  if (tcDelta.function?.arguments) existing.function.arguments += tcDelta.function.arguments;
                }
              }
            }
            const tail = thinkStrip.flush();
            if (tail) {
              chunks.push(tail);
              opts.onChunk!(tail);
            }
            // Fold reasoning into the answer when the model emitted no `content` (mirrors the
            // non-streaming fold in openai-compat.normalizeChoices). Without this, a pure-reasoning
            // reply or one cut off mid-think (finish_reason: length) renders as an empty turn.
            const reasoningText = reasoningChunks.join('');
            const fullText = chunks.join('') || reasoningText;
            const toolCalls = toolCallsByIndex.size
              ? [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc)
              : undefined;
            diagLog('router.stream-done', `${entry.platform}::${entry.modelId} fittedMsgs=${fitted.length} fittedChars=${fitted.reduce((n, mm) => n + (typeof mm.content === 'string' ? mm.content.length : 0), 0)} chunks=${chunks.length} reasoningChunks=${reasoningChunks.length} textLen=${fullText.length} folded=${!chunks.length && !!reasoningText} toolCalls=${toolCallsByIndex.size} finalUsage=${JSON.stringify(finalUsage)}`);

            const promptTokens = finalUsage?.prompt_tokens ?? estimateMessagesTokens(fitted);
            const completionTokens = finalUsage?.completion_tokens ?? estimateTokens(fullText);
            const totalTokens = finalUsage?.total_tokens ?? promptTokens + completionTokens;
            response = {
              id: `chatcmpl-stream-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: entry.modelId,
              choices: [{ index: 0, message: { role: 'assistant', content: fullText, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens,
                ...(finalUsage?.reasoning_tokens !== undefined ? { reasoning_tokens: finalUsage.reasoning_tokens } : {}),
              },
            };
          } else {
            response = await provider.chatCompletion(apiKey, fitted, entry.modelId, completionOpts);
            // Same estimate fallback as the streaming branch above — some providers omit (or
            // zero-fill) `usage` on their completion response. Tools are attached in every mode
            // now (even ask/plan keep read-only tools), so `wantsStream` is false far more often
            // than it used to be — this path, not just the streaming one, needs the fallback so
            // the footer/UsageTracker never silently reads as "0 in · 0 out" for those providers.
            if (!response.usage || (!response.usage.prompt_tokens && !response.usage.completion_tokens)) {
              const fullText = contentToString(response.choices?.[0]?.message?.content ?? '');
              const promptTokens = response.usage?.prompt_tokens || estimateMessagesTokens(fitted);
              const completionTokens = response.usage?.completion_tokens || estimateTokens(fullText);
              response = {
                ...response,
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: response.usage?.total_tokens || promptTokens + completionTokens,
                  ...(response.usage?.reasoning_tokens !== undefined ? { reasoning_tokens: response.usage.reasoning_tokens } : {}),
                },
              };
            }
          }

          if (response.choices?.[0]?.message?.content && typeof response.choices[0].message.content === 'string') {
            response.choices[0].message.content = stripThinkTags(response.choices[0].message.content);
          }

          const responseContent = response.choices?.[0]?.message?.content;
          const hasToolCalls = !!(response.choices?.[0]?.message?.tool_calls?.length);
          if (!responseContent && !hasToolCalls) {
            diagLog('router.empty', `${entry.platform}::${entry.modelId} returned empty content with no tool_calls (http ok) → treating as failure`);            // Was `!forced && ...` — a pinned/forced model has exactly one candidate
            // (candidates() returns a single-entry list, line ~444), so this used to let an
            // empty HTTP-200 response sail through as a "successful" completion whenever a
            // specific model was selected instead of Auto: `continue candidates` immediately
            // exhausts the one-entry loop and throws AllModelsFailedError below, which is what
            // actually surfaces a real error to the user instead of a silently blank reply.
            // Auto mode already treated this as a failure and moved to the next candidate;
            // pinned mode has nowhere to move to, but "nowhere to move to" must still mean
            // "report an error", not "call it a success".
            this.markHealth(entry.platform, entry.modelId, 'bad', 'empty_response');
            this.secrets.setStatus(entry.platform, 'error');
            // An empty completion is a real reliability failure — record it (this path
            // previously skipped metrics, so a model that kept returning nothing never
            // learned a lower success rate and kept getting picked).
            this.metrics?.record(entry.platform, entry.modelId, opts.taskKind ?? 'chat', {
              ok: false, failureType: 'other', totalMs: Date.now() - t0, rateLimited: false,
            } satisfies MetricSample);
            failures.push({ platform: entry.platform, model: entry.modelId, reason: 'empty_response' });
            opts.onFailover?.({ from: entry, reason: 'empty_response' });
            continue candidates;
          }

          const elapsedMs = Date.now() - t0;
          const ttftMs = firstChunkAt !== null ? firstChunkAt - t0 : undefined;
          this.latencyTracker.record(entry.platform, entry.modelId, elapsedMs);
          const kind = opts.taskKind ?? 'chat';
          // Vision-quality demotion: a fluent completion that nonetheless says the model
          // can't see images means the image was dropped upstream (aggregator delegated to a
          // text model, provider flattened the content, …). HTTP succeeded, so it would not
          // otherwise dent reliability — record it as a vision failure so the model self-
          // demotes for future vision turns (the learned complement to the curated ordering).
          const visionBlind = kind === 'vision' && VISION_BLIND.test(contentToString(responseContent));
          this.metrics?.record(entry.platform, entry.modelId, kind, (visionBlind
            ? { ok: false, failureType: 'other', totalMs: elapsedMs, rateLimited: false }
            : { ok: true, ttftMs, totalMs: elapsedMs, rateLimited: false }) satisfies MetricSample);
          this.maybeMarkSlow(entry.platform, entry.modelId, kind, elapsedMs, ttftMs);
          this.usage.add(response.usage);
          this.usageStore?.addRequest(entry.platform, entry.modelId, response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, response.usage?.reasoning_tokens);
          this.secrets.setStatus(entry.platform, 'healthy');
          this.markHealth(entry.platform, entry.modelId, 'ok');

          if (opts.taskKind) {
            const modelKey2 = `${entry.platform}::${entry.modelId}`;
            // Baseline-relative: a success that ran well above the model's own baseline must
            // not (re)pin itself as lastGood — drop a stale pin so the next turn re-evaluates
            // instead of repeating a slow pick. Falls back to the fixed threshold w/o metrics.
            const slow = this.slowModels?.isSlow(entry.platform, entry.modelId) ?? false;
            if (!slow) {
              this.lastGood.set(opts.taskKind, modelKey2);
            } else if (this.lastGood.get(opts.taskKind) === modelKey2) {
              this.lastGood.delete(opts.taskKind);
            }
          }
          opts.onProviderAttempt?.({ platform: entry.platform, model: entry.modelId, status: 'ok', latencyMs: Date.now() - t0 });
          // The rationale reported above (if any) reflects the ranking's top pick, taken before
          // the candidates loop ran — if the actually-served model differs (the top pick failed
          // health/rate-limit/empty-response/error and the loop fell through), re-notify with the
          // real winner so "Why this model?" doesn't keep pointing at a model that never answered.
          if (pickedRank && (pickedRank.top.platform !== entry.platform || pickedRank.top.modelId !== entry.modelId)) {
            // The rationale's `selected` flags were stamped for the ranking's top pick, which
            // never served the request — move the flag (and its "Selected —"/"Not selected"
            // wording) onto the entry that actually served, so the UI's checkmark matches the
            // model shown in the footer instead of the abandoned original pick.
            const rationale = pickedRank.rationale.map((r) => {
              const isRealWinner = r.platform === entry.platform && r.modelId === entry.modelId;
              if (isRealWinner === r.selected) return r;
              return {
                ...r,
                selected: isRealWinner,
                reason: isRealWinner
                  ? `Selected — served the request (ranked lower; the top pick failed to serve)`
                  : `Not selected: ranked #1 but failed to serve`,
              };
            });
            opts.onSelectionRationale?.({ taskKind: pickedRank.taskKind, picked: entry, rationale });
          }
          diagLog('router.served', `${entry.platform}::${entry.modelId} runtimeName="${(provider as any).runtimeName ?? ''}" usage=${JSON.stringify(response.usage)} contentLen=${contentToString(responseContent).length}`);
          return { response, platform: entry.platform, model: entry.modelId, runtimeName: (provider as any).runtimeName };
        } catch (err) {
          const { reason, failoverable, retryAfterMs, detail } = classify(err);
          diagLog('router.catch', `${entry.platform}::${entry.modelId} reason=${reason} failoverable=${!!failoverable} detail=${detail ?? ''} err=${err instanceof Error ? err.message : String(err)}`);

          if (reason === 'http_413' && sentTools && !triedTrim) {
            triedTrim = true;
            reserved = toolsTokens * 2 + 1024;
            continue;
          }

          if (reason === 'rate_limited') {

            this.secrets.setCooldownForKey(apiKey, retryAfterMs ?? this.rateLimitCooldownMs());
            const allKeys = await this.secrets.getKeys(entry.platform);
            const nextKey = allKeys.find((k) => this.secrets.keyCooldownRemaining(k) === 0);
            if (nextKey !== undefined && nextKey !== apiKey) {
              opts.onKeyRotated?.({ platform: entry.platform, keyIndex: allKeys.indexOf(nextKey) + 1, keyTotal: allKeys.length });
              apiKey = nextKey;
              triedTrim = false;
              continue;
            }

            this.secrets.setCooldown(entry.platform, retryAfterMs ?? this.rateLimitCooldownMs());

            if (forced && retryCount < MAX_RETRIES) {
              // Honor the server's Retry-After (Groq/free tiers often ask for 20-40s) instead of
              // capping at 15s and re-429'ing until the retry budget is spent. Cap at 60s so a
              // pathologically long cooldown never hangs the turn indefinitely.
              const waitMs = Math.min(retryAfterMs ?? this.rateLimitCooldownMs(), 60_000);
              opts.onFailover?.({ from: entry, reason: `rate_limited — retrying in ${Math.ceil(waitMs / 1000)}s (${retryCount + 1}/${MAX_RETRIES})` });
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              triedModels.set(modelKey, retryCount + 1);
              continue;
            }
          } else if (reason === 'auth') {
            this.secrets.setStatus(entry.platform, 'invalid');
          } else {
            this.secrets.setStatus(entry.platform, 'error');
          }

          if (sentTools && (reason === 'bad_request' || reason === 'http_413')) {
            this.secrets.markToolIncompatible(entry.platform, entry.modelId);
          }

          if (reason === 'not_found') {
            this.secrets.markDeprecated(entry.platform, entry.modelId);
          }

          this.markHealth(entry.platform, entry.modelId, 'bad', reason);

          triedModels.set(modelKey, retryCount + 1);

          const failElapsed = Date.now() - t0;
          const fType = toFailureType(reason, sentTools);
          this.metrics?.record(entry.platform, entry.modelId, opts.taskKind ?? 'chat', {
            ok: false, failureType: fType, totalMs: failElapsed, rateLimited: reason === 'rate_limited',
          } satisfies MetricSample);
          this.maybeMarkSlow(entry.platform, entry.modelId, opts.taskKind ?? 'chat', failElapsed);

          failures.push({ platform: entry.platform, model: entry.modelId, reason, detail });
          opts.onProviderAttempt?.({ platform: entry.platform, model: entry.modelId, status: 'fail', latencyMs: Date.now() - t0, errorType: reason, reason: detail });

          if (!forced) opts.onFailover?.({ from: entry, reason });
          if (!failoverable || forced) break candidates;
          continue candidates;
        }
      }
    }
    diagLog('router.all-failed', `no candidate served · failures=${failures.map((f) => `${f.platform}::${f.model}(${f.reason})`).join(', ')}`);
    throw new AllModelsFailedError(failures);
  }
}

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

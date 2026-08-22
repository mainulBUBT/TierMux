

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
import { defaultMaxOutputTokens } from '../agent/executionProfile';
import { contentToString } from '../agent/content';
import { diagLog } from '../util/diag';
import { VISION_BLIND } from '../agent/answerQuality';
import { isLikelyVisionModelId } from '../catalog/discovery';
import type { SecretStore } from '../config/secrets';
import type { SettingsStore } from '../config/settingsStore';
import type { Catalog } from '../catalog/catalog';
import type { UsageTracker } from '../config/usage';
import type { UsageStore } from '../config/usageStore';
import type { ModelStatsStore } from '../config/modelStats';
import type { SlowModelStore } from '../config/slowModel';
import { SLOW_LATENCY_MS } from '../config/slowModel';
import { RateTracker } from './rateTracker';
import type { QuotaStore } from '../config/quotaStore';
import { getMockPlayer, buildMockCompletion, getCassetteRecorder } from './mockFixture';
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
const THINK_OPEN_RE = /<(think|thinking|thought|reasoning)>/i;
const THINK_CLOSE_RE = /<\/(think|thinking|thought|reasoning)>/i;
const OPEN_TAG_PREFIXES = ['<think>', '<thinking>', '<thought>', '<reasoning>'];
const CLOSE_TAG_PREFIXES = ['</think>', '</thinking>', '</thought>', '</reasoning>'];

export class ThinkStripper {
  private buf = '';
  private insideThink = false;

  feed(delta: string): string {
    this.buf += delta;
    let out = '';

    while (this.buf.length > 0) {
      if (this.insideThink) {
        const closeMatch = THINK_CLOSE_RE.exec(this.buf);
        if (!closeMatch) {
          let safeCut = this.buf.length;
          const lower = this.buf.toLowerCase();
          for (let i = Math.max(0, lower.length - 12); i < lower.length; i++) {
            const tail = lower.slice(i);
            if (CLOSE_TAG_PREFIXES.some((p) => p.startsWith(tail))) {
              safeCut = i;
              break;
            }
          }
          this.buf = this.buf.slice(safeCut);
          break;
        }

        this.buf = this.buf.slice(closeMatch.index + closeMatch[0].length);
        this.insideThink = false;
        continue;
      }

      const openMatch = THINK_OPEN_RE.exec(this.buf);
      if (!openMatch) {
        let safeUpTo = this.buf.length;
        const lower = this.buf.toLowerCase();
        for (let i = Math.max(0, lower.length - 11); i < lower.length; i++) {
          const tail = lower.slice(i);
          if (OPEN_TAG_PREFIXES.some((p) => p.startsWith(tail))) {
            safeUpTo = Math.min(safeUpTo, i);
          }
        }
        out += this.buf.slice(0, safeUpTo);
        this.buf = this.buf.slice(safeUpTo);
        break;
      }

      out += this.buf.slice(0, openMatch.index);
      this.buf = this.buf.slice(openMatch.index + openMatch[0].length);
      this.insideThink = true;
    }

    return out;
  }

  /** Flush any remaining buffer at stream end. If we're still inside a think block,
   *  discard the buffered reasoning. Otherwise emit any held-back text. */
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

/** Strip `<think>…</think>`, `<thinking>…</thinking>`, and other reasoning tags from a response string. */
export function stripThinkTags(text: string): string {
  let result = text;
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*?<\/\1>/gi, '');
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*?<\/(think|thinking|thought|reasoning)>/gi, '');
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*$/i, '');
  result = result.replace(/^[\s\S]*?<\/(think|thinking|thought|reasoning)>/gi, '');
  result = result.replace(/<\/?(think|thinking|thought|reasoning)>/gi, '');
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
  /** Step routing (Phase 2): only consider models at MOST this smart (intelligenceRank >= this)
   *  — the cheap pool for `[easy]` plan steps (reads/searches), so a lookup step never burns a
   *  top-tier model. Soft filter: if the constrained pool is empty, the full list survives (a
   *  user who enabled only rank-1 models still gets their turn served). Unknown models (custom
   *  endpoints not in the catalog) always pass, mirroring maxIntelligenceRank. */
  minIntelligenceRank?: number;
  /** Chat session this call belongs to. Enables session-sticky Auto routing (see sessionPin):
   *  once a model has served this conversation successfully, keep using it. */
  sessionId?: string;
  /** External cancellation (the Stop button, or a sub-agent's own wall-clock ceiling like
   *  explore.ts's 45s). Forwarded into each provider's fetchWithTimeout so the actual in-flight
   *  HTTP request is cancelled, not just future retries; also checked between failover attempts
   *  so route() stops trying more candidates immediately once aborted. */
  abortSignal?: AbortSignal;
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
  /** Turn telemetry sink: called on every SUCCESSFUL completion with the provider-reported
   *  usage of that call. `contextTokens` (== that request's prompt tokens) and the serving
   *  model's `contextWindow` describe the MOST RECENT request — window pressure, not turn
   *  accounting (see src/shared/workReport.ts for the authoritative semantics). */
  onUsage?: (info: { inputTokens: number; outputTokens: number; contextTokens: number; contextWindow?: number; model: string }) => void;
  /** @internal set by routeHedged — liveness mirror of the TTFT signal: fired on ANY provider
   *  chunk (content, reasoning, keepalive, usage-only). Used to decide the delayed-hedge race
   *  without exposing router internals on the public options. */
  _onProviderAlive?: () => void;
  /** @internal set by routeHedged — fired when the primary loop starts an HTTP attempt on a
   *  candidate, so the hedge can exclude the model the primary is CURRENTLY on (not just the
   *  ones it already failed through onFailover). Without this, a silent-but-not-yet-failed
   *  primary would be re-picked by the hedge — double request to the same dead candidate. */
  _onCandidateStart?: (platform: string, modelId: string) => void;
  /** @internal set by routeHedged — when this signal is aborted, the sibling hedge/primary
   *  request won the race: the loser must exit QUIETLY (no health penalty, no negative
   *  metrics — the model was merely slower, not broken; the winner's stream is already
   *  serving the user). */
  _hedgeLostSignal?: AbortSignal;
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
        case 'paid_only': return `${who} is paid-only or out of free quota on this provider. Add credit/a key in "Manage Models & Keys", pick a different model, or set it to Auto.`;
        case 'content_filter': return `${who} blocked this request before generating a reply.${upstream} Try a different model, or remove/replace the attachment.`;
        default: return `${who} failed (${f.reason}). Try again, or set the model to Auto.${upstream}`;
      }
    }
    // Multi-failure case: the raw `platform/model (reason)` dump is diagnostic noise to a user who
    // just wants their message to send — nobody reading chat needs to know "poolside/laguna-m.1:free
    // (rate_limited)" verbatim. Summarize by reason category instead; the full per-model detail still
    // reaches the log via each candidate's onProviderAttempt callback, so nothing is lost for debugging.
    const counts = new Map<string, number>();
    for (const f of failures) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
    const label = (reason: string, n: number): string => {
      switch (reason) {
        case 'rate_limited': return `${n} rate-limited`;
        case 'auth': return `${n} with a rejected API key`;
        case 'no_api_key': return `${n} missing an API key`;
        case 'timeout': return `${n} timed out`;
        case 'paid_only': return `${n} paid-only/out of quota`;
        case 'not_found': return `${n} unavailable`;
        default: return `${n} failed`;
      }
    };
    const parts = [...counts.entries()].map(([reason, n]) => label(reason, n));
    return `All ${failures.length} configured models are unavailable right now (${parts.join(', ')}). `
      + 'Try again shortly, or check keys/models in "Manage Models & Keys".';
  }
}

/**
 * Thrown when a message carries a visual attachment (an image, or a PDF whose
 * text couldn't be extracted) but no vision-capable model can be found anywhere in the
 * catalog — not even as a last-resort fallback. Better to stop here with an actionable
 * message than to send a turn a text-only model can never fulfill — the model would just
 * refuse ("I can't read this PDF") after burning a request. See candidates(): the vision
 * filter keys off taskKind==='vision' and widens to the full catalog before giving up, so
 * this should only fire when the user has no API key configured for any vision provider.
 */
export class NoVisionModelError extends Error {
  constructor(reason: 'no_vision_model' | 'no_raw_pdf_provider' = 'no_vision_model') {
    super(
      reason === 'no_raw_pdf_provider'
        // Only Google (Gemini) actually forwards raw PDF bytes today (BaseProvider.carriesRawPdf) —
        // other "vision-capable" providers silently drop the file, so the guidance must point at
        // the one platform that really works rather than a generic vision-model list.
        ? 'This message has a scanned/image-only PDF, but none of your configured models can actually read raw PDF ' +
          'bytes (most providers only support images, not PDF files). Open "Manage Models & Keys" and add a Google ' +
          'AI Studio (Gemini) key to read it.'
        : 'This message has an image or PDF attachment, but none of your configured models can read attachments. ' +
          'Open "Manage Models & Keys" and add a key for a vision-capable model (e.g. Gemini, GPT-4o, Claude) to read it.',
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
    if (s === 401) return { reason: 'auth', failoverable: true, detail };
    if (s === 403) {
      // Some gateways (Token Router / new-api) answer a VALID key whose account is out of
      // credit/quota with HTTP 403 ("User's credit limit is insufficient, remaining credit
      // limit: $0.000000"). That is a paid-only/out-of-quota condition, NOT an auth rejection —
      // classifying it as `auth` produces the misleading "rejected the API key" message and
      // sends the user to re-enter a key that already works. Sniff the body for credit/quota
      // language and route it to `paid_only` instead.
      if (detail && /credit|quota|balance|insufficient|out of (?:credit|quota|funds)|no enough/i.test(detail)) {
        return { reason: 'paid_only', failoverable: true, detail };
      }
      return { reason: 'auth', failoverable: true, detail };
    }
    if (s === 408) return { reason: 'timeout', failoverable: true, detail };
    if (s === 413) return { reason: 'http_413', failoverable: true, detail };
    if (s === 404) return { reason: 'not_found', failoverable: true, detail };
    if (s === 400) return { reason: 'bad_request', failoverable: true, detail };

    if (s === 402) return { reason: 'paid_only', failoverable: true, detail };
    if (s && s >= 500) return { reason: 'server_error', failoverable: true, detail };
    return { reason: `http_${s ?? '?'}`, failoverable: true, detail };
  }

  // Google throws a plain Error (no HTTP status — the response itself was 200) when a prompt
  // gets blocked (safety/recitation) instead of returning a candidate — see google.ts's
  // promptFeedback/finishReason check. Recognize its message so the surfaced failure reads as
  // an actionable content-block notice instead of a generic "network" failure.
  if (detail?.startsWith('Google blocked this request')) {
    return { reason: 'content_filter', failoverable: true, detail };
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
  /**
   * Last model that successfully served each CHAT SESSION — tried first next time, ahead of the
   * per-taskKind `lastGood` pin.
   *
   * `lastGood` is keyed by task kind, which means one conversation gets re-routed every time the
   * classifier's label shifts: a measured 20-query Auto run was served by SIX different models,
   * including a *tiny* one that then failed a bugfix task. That is the opposite of how Claude
   * Code / Copilot behave, and it breaks continuity — each turn is answered by a model with a
   * different idea of what the previous turns meant.
   *
   * Same guards as `lastGood` (still a candidate, not disliked, not flagged slow), so a pinned
   * model that starts failing or crawling still loses the seat. Bounded so long-lived windows
   * don't accumulate one entry per session forever.
   */
  private sessionPin = new Map<string, string>();
  private static readonly MAX_SESSION_PINS = 100;
  /** Smartest-rank a session pin may have and still jump the queue (lower rank = smarter).
   *  Verified against the catalog: the free models actually observed in bench runs resolve to
   *  ranks 1–3, so this admits the top two tiers and excludes the tail. */
  private static readonly SESSION_PIN_MAX_RANK = 2;
  private rateTracker: RateTracker;
  private latencyTracker = new LatencyTracker();
  /** Epoch-ms of each model's last successful serve — feeds tied-band rotation in ScoringEngine. */
  private lastServedAt = new Map<string, number>();
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
  /** Longest rate-limit cooldown route() will sleep off before attempting a last-resort
   *  candidate (see the cooldown check at the top of the candidates loop). Longer cooldowns
   *  are attempted immediately instead of blocking the turn — bounded latency either way. */
  private static readonly COOLDOWN_WAIT_CAP_MS = 15_000;
  private static readonly PING_TIMEOUT_MS = 1200;

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
    quotaStore?: QuotaStore,
  ) {
    // Hydrated from the persistent ledger when present, so a window reload keeps the
    // RPM/RPD windows already consumed this minute/day instead of re-hammering providers.
    this.rateTracker = new RateTracker(quotaStore);
  }

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

    const keyless = await pick([
      'ovh::gpt-oss-120b', 'ovh::Meta-Llama-3_3-70B-Instruct', 'pollinations::openai-fast',
      'opencode::deepseek-v4-flash-free', 'kilo::kilo-auto/free',
    ]);
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

  /**
   * Return the model that WOULD be picked for a taskKind, without making any network call —
   * so callers can gate behavior on the executor's capability (the planner→execute pipeline
   * plans only when this top model is weak). Reuses the same ranking path as `route()`:
   * Smart Auto scoring when active, else the legacy `orderForTask` ordering. This is an
   * approximation of `route()`'s pick (it skips the per-call context-fit + latency tiebreaks),
   * which is fine for a capability gate — we only need the right quality tier.
   *
   * `requireTools: true` because every caller of this (the mixture-pipeline gate) only peeks
   * for task kinds whose real turn always carries the full tool set — without this, a smart
   * but tool-less model could top the peek, reporting a falsely-strong executor while the
   * actual (tool-filtered) route() pick is much weaker.
   */
  /** Record the model serving a session, evicting the oldest entry past the cap. Re-setting an
   *  existing session moves it to the end (Map preserves insertion order), so an active
   *  conversation is never the one evicted. */
  private setSessionPin(sessionId: string, modelKey: string): void {
    this.sessionPin.delete(sessionId);
    this.sessionPin.set(sessionId, modelKey);
    while (this.sessionPin.size > Router.MAX_SESSION_PINS) {
      const oldest = this.sessionPin.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessionPin.delete(oldest);
    }
  }

  /** Forget a session's sticky model — call when the user deletes a session or explicitly picks
   *  a model, so a stale pin can't outlive the conversation it belonged to. */
  clearSessionPin(sessionId: string): void {
    this.sessionPin.delete(sessionId);
  }

  peekTopSelection(taskKind: TaskKind): { entry: FallbackEntry; model?: CatalogModel } | undefined {
    const base = { taskKind, requireTools: true } as RouteOptions;
    let cands = this.candidates(base);
    if (cands.length === 0) return undefined;
    if (this.smartScoringActive()) {
      const ctx = this.buildSelectionContext(taskKind, cands, base);
      cands = this.scoring!.rank(ctx).ordered;
    } else {
      cands = orderForTask(taskKind, cands, this.catalog);
    }
    const entry = cands[0];
    if (!entry) return undefined;
    return { entry, model: this.catalog.find(entry.platform, entry.modelId) };
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
    return { taskKind: kind, entries, runtime, requireTools: !!opts.requireTools, isVision: kind === 'vision', reasoningEffort: opts.reasoningEffort, lastServedAt: this.lastServedAt };
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
  /** Platforms that are auth-ready (keyless, or with at least one key stored). Models on OTHER
   *  platforms can't actually run — excluding them up front means they don't take a candidate slot,
   *  pollute the selection rationale, or waste a key-resolution round-trip before the request-time
   *  no_api_key skip fires. `configured` already encodes keyless||hasKey (see SecretStore.snapshot),
   *  so keyless providers are kept. Returns an empty set on error so the filter is skipped (safe). */
  private async configuredPlatformSet(): Promise<Set<Platform>> {
    try {
      const snap = await this.secrets.snapshot();
      return new Set(snap.filter((p) => p.configured).map((p) => p.platform));
    } catch {
      return new Set();
    }
  }

  private candidates(opts: RouteOptions): FallbackEntry[] {
    let list = this.settings.enabledByPriority();
    const forcedModel = !!(opts.model && opts.model !== 'auto');
    if (forcedModel) {
      const [platform, ...rest] = opts.model!.split('::');
      const modelId = rest.join('::');

      const forced = list.find((e) => e.platform === platform && e.modelId === modelId);
      const forcedEntry: FallbackEntry = forced ?? { platform: platform as Platform, modelId, enabled: true, priority: -1 };
      diagLog('router.candidates', `forced model="${opts.model}" → platform=${platform} modelId=${modelId} foundInCatalog=${!!forced}`);

      if (opts.taskKind === 'vision') {
        // A pinned model that can't actually see this turn's image/PDF must not silently eat the
        // request — it has nothing to go on and hallucinates an unrelated answer (confirmed in
        // practice: a pinned text-only model asked to read a scanned PDF invented a description of
        // a completely different project). Check the pin's real capability before honoring it.
        const info = this.catalog.find(forcedEntry.platform, forcedEntry.modelId);
        const canSeeImages = forcedEntry.platform === 'custom'
          ? isLikelyVisionModelId(forcedEntry.modelId.split('::').slice(1).join('::'))
          : !!info?.supportsVision;
        const provider = resolveProvider(forcedEntry.platform, forcedEntry.modelId, this.settings.getCustomEndpoints());
        const flattens = !!(provider as { flattenContent?: boolean } | undefined)?.flattenContent;
        const rejectsThisPdf = !!(opts.hasRawPdfPart && info?.rejectsRawPdf);
        // A raw-PDF turn additionally requires a provider that actually forwards `type:'file'`
        // blocks (today: only Google) — most providers are vision-capable for images but
        // silently drop PDF file parts, which otherwise looked "usable" and produced a model
        // confidently reporting it saw no attachment at all.
        const dropsThisPdf = !!(opts.hasRawPdfPart && !provider?.carriesRawPdf);
        const usable = canSeeImages && !flattens && !rejectsThisPdf && !dropsThisPdf;

        if (!usable) {
          diagLog('router.candidates', `forced model="${opts.model}" can't read this turn's attachment — substituting a vision-capable model for this turn`);
          // Fall through to the normal (non-forced) candidate pipeline below, which already
          // filters/widens to vision-capable models for taskKind==='vision'. The user's pin
          // resumes automatically on the next turn that doesn't carry a visual attachment.
        } else {
          return [forcedEntry];
        }
      } else {
        return [forcedEntry];
      }
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
      // Custom/local endpoints aren't in the built-in catalog, so fall back to the same
      // name-based heuristic used for freshly-discovered cloud models rather than excluding
      // them outright (unknown != false) or blindly assuming every local model can see.
      const isVisionCapable = (e: FallbackEntry): boolean =>
        e.platform === 'custom'
          ? isLikelyVisionModelId(e.modelId.split('::').slice(1).join('::'))
          : !!this.catalog.find(e.platform, e.modelId)?.supportsVision;

      let visionCapable = list.filter(isVisionCapable);
      if (visionCapable.length === 0) {
        // The user's manually-enabled models have nothing vision-capable. Rather than fail the
        // turn outright, widen the search to the FULL catalog (including providers the user has
        // a key for but never toggled "enabled") — Auto mode is the recommended default and
        // should just work when a usable vision model exists. This doesn't bypass cost/key
        // control: candidates without a configured API key still get skipped by the normal
        // no_api_key failover a few dozen lines below, so this only helps when a real key is
        // already on file for that provider.
        const known = new Set(list.map((e) => `${e.platform}::${e.modelId}`));
        const extra = this.catalog
          .all()
          .filter((m) => m.supportsVision && !known.has(`${m.platform}::${m.modelId}`))
          .map((m): FallbackEntry => ({ platform: m.platform, modelId: m.modelId, enabled: true, priority: 999 }));
        visionCapable = extra;
        if (visionCapable.length === 0) throw new NoVisionModelError();
      }
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
        // Unlike the image-carrying preference above, this is a HARD filter, not a
        // prefer-with-fallback: a provider that doesn't forward `type:'file'` blocks (see
        // BaseProvider.carriesRawPdf) sends NO pdf bytes at all — falling back to one would
        // reproduce the original bug (model reports no attachment, or hallucinates). Also drop
        // models individually flagged as refusing a raw PDF even when their provider forwards it.
        const acceptsRawPdf = list.filter((e) => {
          const p = resolveProvider(e.platform, e.modelId, this.settings.getCustomEndpoints());
          if (!p?.carriesRawPdf) return false;
          return !this.catalog.find(e.platform, e.modelId)?.rejectsRawPdf;
        });
        if (acceptsRawPdf.length === 0) throw new NoVisionModelError('no_raw_pdf_provider');
        list = acceptsRawPdf;
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
    if (opts.minIntelligenceRank != null) {
      // Soft ceiling: keep only the cheap pool, but NEVER fail the turn for a difficulty
      // constraint — when the user's enabled models are all smarter than the ceiling, the
      // full list survives and the turn simply runs on what exists.
      const ceilRank = opts.minIntelligenceRank;
      const cheap = list.filter((e) => {
        const m = this.catalog.find(e.platform, e.modelId);
        return !m || m.intelligenceRank >= ceilRank;
      });
      if (cheap.length > 0) list = cheap;
    }

    if (opts.taskKind) {
      const kind = opts.taskKind;
      const score = this.stats ? (p: string, m: string): number => this.stats!.score(kind, p, m) : undefined;
      list = orderForTask(kind, list, this.catalog, score);

      // Session pin applied AFTER the taskKind pin so it ends up in front of it — continuity
      // within one conversation outranks "what worked for this label globally".
      const pins = [this.lastGood.get(kind), opts.sessionId ? this.sessionPin.get(opts.sessionId) : undefined];
      for (const good of pins) {
        if (!good) continue;
        const i = list.findIndex((e) => `${e.platform}::${e.modelId}` === good);
        const notDisliked = !this.stats || this.stats.score(kind, list[i]?.platform, list[i]?.modelId) >= 0;
        // A pin must not resurrect a model currently flagged slow — "it answered" is not "it
        // answered acceptably fast", and the pin otherwise self-renews forever (each slow
        // success re-writes it, so the same 200s+ model wins every turn).
        const notSlow = i < 0 || !this.slowModels?.isSlow(list[i].platform, list[i].modelId);
        // Capability floor. A pin is continuity, not a verdict on capability: the model that
        // happened to answer "what does this file do" is often a weak one, and letting that win
        // sticks the WHOLE conversation to it — including the later turn that asks for a
        // multi-file refactor. Only pin a model the ranking would consider for real work; a
        // weaker one still gets used, it just doesn't get to jump the queue.
        const pinRank = i < 0 ? undefined : this.catalog.find(list[i].platform, list[i].modelId)?.intelligenceRank;
        const capable = pinRank === undefined || pinRank <= Router.SESSION_PIN_MAX_RANK;
        if (i > 0 && notDisliked && notSlow && capable) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
      }
    }

    const ready = list.filter((e) => this.secrets.cooldownRemaining(e.platform) === 0);
    if (ready.length > 0) {
      // Keep providers in a rate-limit cooldown IN the list (after every ready candidate)
      // instead of dropping them. One 429 used to exclude the WHOLE provider from the turn:
      // with a chain heavy on free routers, most of it could be cooling down at once, the
      // ready remainder could be just 1–2 models, and their failure ended the turn with
      // "All 2 configured models are unavailable" while dozens of enabled models sat in a
      // seconds-long cooldown the router never waited out. These last-resort entries are
      // only reached when every ready candidate has failed; short cooldowns are slept off
      // there (see the cooldown check at the top of the candidates loop in route()).
      const cooling = list
        .filter((e) => this.secrets.cooldownRemaining(e.platform) > 0)
        .sort((a, b) => this.secrets.cooldownRemaining(a.platform) - this.secrets.cooldownRemaining(b.platform));
      return [...ready, ...cooling];
    }
    return [...list].sort(
      (a, b) => this.secrets.cooldownRemaining(a.platform) - this.secrets.cooldownRemaining(b.platform),
    );
  }

  private rateLimitCooldownMs(): number {
    return vscodeConfigNumber('tiermux.rateLimitCooldownMs', 60000);
  }

  /** Sleep `ms`, resolving early if `abortSignal` fires (Stop button / sub-agent ceiling) —
   *  a cooldown wait must never outlive the user's patience for the whole turn. */
  private waitCooldown(ms: number, abortSignal?: AbortSignal): Promise<void> {
    if (ms <= 0 || abortSignal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => done();
      const timer = setTimeout(done, ms);
      abortSignal?.addEventListener('abort', onAbort);
    });
  }

  private timeoutMs(): number {
    return vscodeConfigNumber('tiermux.requestTimeoutMs', 30000);
  }

  /** Per-provider floor: ZenMux and other queued free routers need more than the 60s default
   *  to survive cold starts; honor the provider's declared minimum so a user-tuned 60s setting
   *  doesn't accidentally cap a slow provider below what it needs. */
  private timeoutMsFor(provider: { timeoutMs?: number }): number {
    const floor = provider.timeoutMs ?? 0;
    return Math.max(this.timeoutMs(), floor);
  }

  /** TTFT-gated fast failover (lightweight hedging). If a streaming candidate accepts the
   *  connection but emits NO chunk — not even reasoning/keepalive — within this many ms, abort
   *  it and fail over to the next candidate instead of blocking the full requestTimeoutMs.
   *  Catches the case preflight can't: the model passed the 1-token ping then hangs mid-stream.
   *  Full request-level hedging (racing two live streams, doubling token cost) was judged not
   *  worth it here; this delivers the same user-visible win (no 30s stalls on a slow model) at
   *  zero extra token cost. 0 disables. Clamped to never exceed requestTimeoutMs. */
  private ttftTimeoutMs(): number {
    const v = vscodeConfigNumber('tiermux.ttftTimeoutMs', 8000);
    if (v <= 0) return 0;
    return Math.min(v, this.timeoutMs());
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

  /** How many leading candidates to pre-flight ping concurrently. Cuts the serial-per-candidate
   *  cold-start tax (each cold model used to add up to PING_TIMEOUT_MS inside the failover loop)
   *  by overlapping the pings. Small on purpose so a cold session doesn't spam free tiers. */
  private static readonly PREFLIGHT_WARMUP = 3;

  /**
   * Fire pre-flight pings for the leading candidates CONCURRENTLY, before the serial failover
   * loop runs. Each ping's result lands in the `health` cache, which the loop reads unchanged —
   * so the first cold failover no longer pays a serial ~PING_TIMEOUT_MS wait; the top-K pings
   * overlap instead. Mirrors the loop's own preflight conditions (only ping unknown/half-open
   * candidates on their first try, skip providers with `skipPreflight`) and is best-effort:
   * `preflightPing` already swallows errors into the cache, so this never throws.
   */
  private async preflightWarmup(
    cands: Array<{ platform: Platform; modelId: string; key?: string }>,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (abortSignal?.aborted) return;
    const custom = this.settings.getCustomEndpoints();
    const toProbe: Array<Promise<{ ok: boolean; reason?: string }>> = [];
    for (const entry of cands.slice(0, Router.PREFLIGHT_WARMUP)) {
      const provider = resolveProvider(entry.platform, entry.modelId, custom);
      if (!provider || provider.skipPreflight) continue;
      const cached = this.healthOf(entry.platform, entry.modelId);
      if (cached === 'ok' || cached === 'bad') continue; // only warm unknown / half-open
      if (cached === 'half-open') this.markProbing(entry.platform, entry.modelId); // claim the trial
      const apiKey = entry.key
        ?? await this.secrets.getModelKey(entry.platform, entry.modelId)
        ?? await this.secrets.resolveKey(entry.platform, entry.modelId);
      if (apiKey === undefined) continue;
      if (abortSignal?.aborted) return;
      toProbe.push(this.preflightPing(provider, apiKey, entry.platform, entry.modelId));
    }
    if (toProbe.length > 0) {
      diagLog('router.warmup', `pre-flight pinging ${toProbe.length} candidate(s) in parallel`);
      await Promise.allSettled(toProbe);
    }
  }

  /**
   * Zero-token dev/test shortcut for ask/plan/agent modes — gated behind
   * TIERMUX_FAKE_MODEL=1 so it's never active for a real user. Returns a canned
   * response instead of calling any provider, letting F5 dev-host testing exercise
   * the real system prompt, tool set, and streamText plumbing for every mode
   * without spending real API tokens. On the first turn with tools available it
   * emits one canned tool-call (so the tool round-trip is exercised too); once the
   * tool result comes back, it finishes with text so the turn doesn't loop forever.
   */
  private async fakeRoute(messages: ChatMessage[], opts: RouteOptions): Promise<RouteResult> {
    diagLog('router.fake', `taskKind=${opts.taskKind ?? '<none>'} tools=${opts.tools?.length ?? 0}`);

    // Scripted fixture first — a MockPlayer queue for this taskKind (or its exhausted default)
    // replaces the canned dummy entirely, so a whole weak-model scenario (tool call → dialect
    // text → paste-in-chat → nudge → recovery) replays deterministically with zero tokens.
    const scripted = getMockPlayer()?.next(opts.taskKind);
    if (scripted) {
      const { message, finish_reason } = buildMockCompletion(scripted.respond);
      if (finish_reason === 'stop' && typeof message.content === 'string' && opts.onChunk) opts.onChunk(message.content);
      return {
        response: {
          id: 'mock-completion',
          object: 'chat.completion',
          created: Date.now(),
          model: 'mock-model',
          choices: [{ index: 0, message, finish_reason }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
        platform: 'fake' as Platform,
        model: 'mock-model',
        runtimeName: 'Mock (scripted fixture)',
      };
    }

    const lastMessageWasToolResult = messages[messages.length - 1]?.role === 'tool';
    const firstTool = opts.tools?.[0];
    const wantsToolCall = !!firstTool && !lastMessageWasToolResult;

    const message: ChatMessage = wantsToolCall
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'fake_call_1',
            type: 'function',
            function: { name: firstTool!.function.name, arguments: this.fakeArgsFor(firstTool!) },
          }],
        }
      : { role: 'assistant', content: `[fake:${opts.taskKind ?? 'chat'}] canned response — no tokens spent.` };

    if (!wantsToolCall && opts.onChunk && typeof message.content === 'string') opts.onChunk(message.content);

    return {
      response: {
        id: 'fake-completion',
        object: 'chat.completion',
        created: Date.now(),
        model: 'fake-model',
        choices: [{ index: 0, message, finish_reason: wantsToolCall ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      platform: 'fake' as Platform,
      model: 'fake-model',
      runtimeName: 'Fake (no tokens)',
    };
  }

  /** Minimal, schema-shaped placeholder args so a canned fake tool-call doesn't fail
   *  the tool's own input validation — fills required string/number/array properties. */
  private fakeArgsFor(tool: NonNullable<RouteOptions['tools']>[number]): string {
    const params = tool.function.parameters as { properties?: Record<string, { type?: string }>; required?: string[] } | undefined;
    const args: Record<string, unknown> = {};
    for (const key of params?.required ?? []) {
      const type = params?.properties?.[key]?.type;
      args[key] = type === 'number' ? 0 : type === 'boolean' ? false : type === 'array' ? [] : 'fake';
    }
    return JSON.stringify(args);
  }

  /** Record a "soft" tool failure for the model that just served a turn (emitted a text tool-call,
   *  or announced an action and called no tool). Passthrough to the SecretStore's strike counter,
   *  which benches the model from tool routing after repeated strikes. No-op on missing ids. */
  noteToolSoftFailure(platform?: string, modelId?: string): void {
    if (platform && modelId) this.secrets.noteToolSoftFailure(platform as Platform, modelId);
  }

  async route(messages: ChatMessage[], opts: RouteOptions = {}): Promise<RouteResult> {
    if (process.env.TIERMUX_FAKE_MODEL === '1') return this.fakeRoute(messages, opts);
    return this.routeHedged(messages, opts);
  }

  /** Hedging config: 0 / `tiermux.hedging:false` disables; otherwise clamped below the TTFT
   *  gate so the hedge always fires before single-candidate fast-failover would. */
  private hedgeDelayMs(): number {
    if (!vscodeConfigBoolean('tiermux.hedging', true)) return 0;
    const v = vscodeConfigNumber('tiermux.hedgeDelayMs', 2500);
    if (v <= 0) return 0;
    const ttft = this.ttftTimeoutMs();
    return ttft > 0 ? Math.min(v, Math.max(500, ttft - 500)) : v;
  }

  /**
   * DELAYED HEDGING (lightweight request racing) around the serial failover loop.
   *
   * The serial loop is correct but pays wall-clock for every silent candidate: a model that
   * accepts the connection then says nothing burns the full TTFT window (8s default) before
   * failover even starts. Full racing (two live streams always) doubles token cost and was
   * deliberately rejected (see ttftTimeoutMs). This is the middle path:
   *
   *   t=0      primary request starts (the normal top-ranked candidate)
   *   t=hedged if primary has produced NO provider chunk at all → start the NEXT candidate
   *            concurrently, excluding everything primary already tried
   *   first wire chunk from either side wins; the loser is aborted immediately
   *
   * Common case (primary healthy): the hedge never fires — zero extra tokens. Slow case: the
   * user waits hedgeDelayMs (2.5s default) instead of the full serial chain. Both sides
   * record against the rate tracker, so quota stays honest.
   *
   * Raced on "any provider chunk" (same signal the TTFT gate uses), NOT on first user-visible
   * content — a healthy model streaming a long tool-call JSON stays 'alive' and is never
   * double-served. The loser exits through `_hedgeLostSignal` without health/metrics
   * penalties (slow ≠ broken). Skipped for: pinned/forced models, non-streaming turns,
   * disabled config, or an already-aborted request.
   */
  private routeHedged(messages: ChatMessage[], opts: RouteOptions): Promise<RouteResult> {
    const hedgeMs = this.hedgeDelayMs();
    const canHedge =
      hedgeMs > 0 &&
      !!opts.onChunk &&
      !(opts.model && opts.model !== 'auto') &&
      !opts.abortSignal?.aborted;
    if (!canHedge) return this.routeSerial(messages, opts);

    const userSignal = opts.abortSignal;
    const primaryCtrl = new AbortController();
    const hedgeCtrl = new AbortController();
    const onUserAbort = (): void => {
      primaryCtrl.abort();
      hedgeCtrl.abort();
    };
    userSignal?.addEventListener('abort', onUserAbort, { once: true });

    /** Winner of the liveness race; until set, both sides may stream. Set synchronously on the
     *  first provider chunk of either side — single-threaded JS makes this a clean arbiter. */
    let winner: 'primary' | 'hedge' | undefined;
    /** Models the primary loop has already moved past (its onFailover stream) — the hedge
     *  excludes them so the two loops don't re-try the same dead candidate. */
    const primaryTried = new Set<string>(opts.exclude ?? []);

    const claimWin = (who: 'primary' | 'hedge'): void => {
      if (winner !== undefined) return;
      winner = who;
      (who === 'primary' ? hedgeCtrl : primaryCtrl).abort();
    };

    const primaryOpts: RouteOptions = {
      ...opts,
      abortSignal: primaryCtrl.signal,
      _hedgeLostSignal: hedgeCtrl.signal,
      _onProviderAlive: () => claimWin('primary'),
      _onCandidateStart: (p, m) => primaryTried.add(`${p}::${m}`),
      onChunk: (t: string) => {
        if (winner !== undefined && winner !== 'primary') return; // lost — suppress duplicate output
        claimWin('primary');
        opts.onChunk!(t);
      },
      onFailover: opts.onFailover
        ? (info) => {
          primaryTried.add(`${info.from.platform}::${info.from.modelId}`);
          opts.onFailover!(info);
        }
        : (info) => {
          primaryTried.add(`${info.from.platform}::${info.from.modelId}`);
        },
    };

    return new Promise<RouteResult>((resolve, reject) => {
      let hedgePromise: Promise<RouteResult> | undefined;
      const hedgeTimer = setTimeout(() => {
        if (winner !== undefined) return; // primary already alive; nothing to hedge
        const hedgeOpts: RouteOptions = {
          ...opts,
          exclude: [...primaryTried],
          abortSignal: hedgeCtrl.signal,
          _hedgeLostSignal: primaryCtrl.signal,
          _onProviderAlive: () => claimWin('hedge'),
          onChunk: (t: string) => {
            if (winner !== undefined && winner !== 'hedge') return;
            claimWin('hedge');
            opts.onChunk!(t);
          },
          // Duplicate UI chatter from the shadow request is noise — the user follows the
          // winner's stream; per-attempt profiler events still flow.
          onFailover: undefined,
          onKeyRotated: undefined,
          onSelectionRationale: undefined,
        };
        hedgePromise = this.routeSerial(messages, hedgeOpts);
        hedgePromise.then(resolve, (hedgeErr: unknown) => {
          // Hedge lost the liveness race (aborted away) or genuinely failed. If primary is
          // still live its own settlement below decides; if primary already won this is a
          // no-op (outer promise settled).
          if (winner === 'hedge') reject(hedgeErr);
        });
      }, hedgeMs);

      this.routeSerial(messages, primaryOpts).then((res) => {
        clearTimeout(hedgeTimer);
        claimWin('primary'); // a completed result wins even if it never emitted a chunk
        if (winner === 'primary') resolve(res);
      }, (err: unknown) => {
        clearTimeout(hedgeTimer);
        if (winner === 'hedge') return; // hedge owns the turn; its settlement decides
        if (hedgePromise) {
          // Primary is dead and a hedge is in flight — keep waiting for it before failing.
          hedgePromise.then(resolve, () => reject(err));
        } else {
          hedgeCtrl.abort();
          reject(err);
        }
      });
    }).finally(() => {
      userSignal?.removeEventListener('abort', onUserAbort);
    });
  }

  private async routeSerial(messages: ChatMessage[], opts: RouteOptions): Promise<RouteResult> {
    const failures: Array<{ platform: Platform; model: string; reason: string; detail?: string }> = [];
    const sentTools = !!(opts.tools && opts.tools.length);
    const toolsTokens = sentTools ? estimateTokens(JSON.stringify(opts.tools)) : 0;

    const triedModels = new Map<string, number>();
    // One retry, not three: a rate-limited free model rarely recovers within a single turn's
    // patience, so a second wait+retry is usually just dead latency. After one attempt, move on
    // (fail over in Auto, or surface the error for a pinned model).
    const MAX_RETRIES = 1;

    let cands = this.candidates(opts);
    const forced = !!(opts.model && opts.model !== 'auto');
    // Output budget sentinel for context reservation. The actual wire value is computed per
    // candidate (its own model's reasoning flag + declared cap) from the SAME helper, so the
    // reservation approximates from the likely winner — the top candidate after filtering.
    const sentinelModel = cands.length ? this.catalog.find(cands[0].platform, cands[0].modelId) : undefined;
    const maxOut = opts.max_tokens ?? defaultMaxOutputTokens(sentinelModel);
    // Drop candidates on providers that aren't auth-ready (not keyless AND no key stored). They'd
    // be skipped at request time anyway (no_api_key), but excluding them here keeps them out of the
    // selection rationale and avoids a wasted key-resolution round-trip per candidate. A forced/
    // pinned model is exempt — the user asked for it explicitly, so let request-time handle it.
    if (!forced) {
      const configured = await this.configuredPlatformSet();
      if (configured.size > 0) {
        const before = cands.length;
        cands = cands.filter((e) => configured.has(e.platform));
        if (cands.length < before) diagLog('router.candidates', `dropped ${before - cands.length} candidate(s) on providers with no key (not keyless, no key stored)`);
      }
    }
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

    // Session model lock (OpenCode-style per-session continuity): Smart Auto scoring re-ranks
    // every turn, which let one conversation drift across models with different ideas of what
    // the earlier turns meant. When a session has a pin and the pinned model is still a viable
    // candidate — healthy, quota available, not flagged slow, capable tier — it takes the seat
    // back from the scorer. A real failure (429s, health=bad, slow) still rotates: the lock
    // holds only while the model actually can serve.
    if (vscodeConfigBoolean('tiermux.agent.sessionModelLock', true) && !forced && opts.sessionId && cands.length > 1) {
      const lockKey = this.sessionPin.get(opts.sessionId);
      const idx = lockKey ? cands.findIndex((e) => `${e.platform}::${e.modelId}` === lockKey) : -1;
      if (idx > 0) {
        const entry = cands[idx];
        const m = this.catalog.find(entry.platform, entry.modelId);
        const healthy = this.healthOf(entry.platform, entry.modelId) !== 'bad';
        const canSend = m ? this.rateTracker.canSend(entry.platform, entry.modelId, m.rpmLimit, m.rpdLimit) : true;
        const notSlow = !this.slowModels?.isSlow(entry.platform, entry.modelId);
        const capable = !m || m.intelligenceRank <= Router.SESSION_PIN_MAX_RANK;
        if (healthy && canSend && notSlow && capable) {
          cands = [entry, ...cands.slice(0, idx), ...cands.slice(idx + 1)];
          diagLog('router.sessionLock', `session ${opts.sessionId} locked to ${lockKey} (healthy, quota ok)`);
        }
      }
    }

    // Re-assert ready-before-cooling AFTER the re-ranking steps above. candidates() orders
    // it that way, but neither the Smart-Auto scorer nor the complexity/latency sorts know
    // about platform rate-limit cooldowns — left alone they can float a cooling model over
    // healthy ready ones and burn requests on a provider we already know is 429ing.
    if (!forced && cands.length > 1) {
      const cooling = cands.filter((e) => this.secrets.cooldownRemaining(e.platform) > 0);
      if (cooling.length > 0 && cooling.length < cands.length) {
        const ready = cands.filter((e) => this.secrets.cooldownRemaining(e.platform) === 0);
        diagLog('router.candidates', `${ready.length} ready candidate(s) kept ahead of ${cooling.length} rate-limit-cooling one(s)`);
        cands = [...ready, ...cooling];
      }
    }

    // Warm the leading candidates' pre-flight health CONCURRENTLY before the serial failover
    // loop, so a cold session doesn't pay one serial PING_TIMEOUT_MS per candidate. Best-effort:
    // results land in the `health` cache the loop already reads, and preflightPing never throws.
    // Skipped for a forced/pinned model (single candidate — nothing to overlap).
    if (!forced) await this.preflightWarmup(cands, opts.abortSignal);

    candidates: for (const entry of cands) {
      // Once aborted (Stop button, or a sub-agent's own wall-clock ceiling), stop trying MORE
      // candidates immediately — without this, an abort only cancelled the CURRENTLY in-flight
      // request (see fetchWithTimeout) but the failover loop kept moving on to the next model,
      // multiplying the wait by however many more candidates it tried before giving up.
      if (opts.abortSignal?.aborted) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: 'aborted' });
        break candidates;
      }
      const modelKey = `${entry.platform}::${entry.modelId}`;
      const retryCount = triedModels.get(modelKey) || 0;

      if (retryCount >= MAX_RETRIES) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: `tried ${MAX_RETRIES} times` });
        continue;
      }

      // Last-resort candidate (appended past the ready set by candidates()): its provider is
      // in a rate-limit cooldown. A SHORT cooldown is worth waiting out — that is the
      // difference between "Auto recovered after a few seconds" and a dead turn — while a
      // long one is attempted immediately, same as the old all-cooling path (a fresh 429
      // just failovers through the normal machinery).
      const cooldownLeft = this.secrets.cooldownRemaining(entry.platform);
      if (cooldownLeft > 0 && cooldownLeft <= Router.COOLDOWN_WAIT_CAP_MS) {
        diagLog('router.cooldown', `${entry.platform}::${entry.modelId} rate-limit cooldown ${cooldownLeft}ms left — waiting it out`);
        await this.waitCooldown(cooldownLeft, opts.abortSignal);
        if (opts.abortSignal?.aborted) {
          failures.push({ platform: entry.platform, model: entry.modelId, reason: 'aborted' });
          break candidates;
        }
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

      if (apiKey === undefined) {
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

      // TTFT-gated fast failover (see ttftTimeoutMs): for streaming requests, build a composite
      // abort signal that fires on EITHER the user's Stop OR our own TTFT timer. The TTFT abort
      // throws inside the stream loop below → classified 'network' (failoverable) → next candidate,
      // without touching opts.abortSignal (so the Stop button stays independent). Non-streaming
      // requests use opts.abortSignal directly; the normal timeoutMs governs them.
      const wantsStreamPre = !!opts.onChunk;
      const ttftMs = wantsStreamPre ? this.ttftTimeoutMs() : 0;
      const ttftController = ttftMs > 0 ? new AbortController() : undefined;
      const perCandidateAbort = ttftController && opts.abortSignal
        ? AbortSignal.any([opts.abortSignal, ttftController.signal])
        : (ttftController ? ttftController.signal : opts.abortSignal);

      const completionOpts: CompletionOptions = {
        temperature: opts.temperature,
        // Floor the output budget when the caller didn't set one. Without this, `max_tokens` is
        // omitted from the request and the provider applies its own (often low) default — a
        // long single-stream answer (e.g. Ask mode) then hits the cap mid-answer. The old flat
        // 4096/8192 floors truncated mid-answer on free tiers and leaned on the continuation
        // stitcher (up to 4 extra calls) to band-aid it; the profile helper raises the floor
        // (reasoning models get double room for hidden <think> output) while a declared
        // outputTokenLimit always caps below it.
        max_tokens: opts.max_tokens ?? defaultMaxOutputTokens(model),
        top_p: opts.top_p,
        tools: opts.tools,
        tool_choice: opts.tool_choice,
        parallel_tool_calls: opts.parallel_tool_calls,
        reasoningEffort: model?.supportsReasoning ? opts.reasoningEffort : undefined,
        baseUrlOverride: this.settings.getEndpoint(entry.platform),
        timeoutMs: opts.timeoutMs ?? this.timeoutMsFor(provider as { timeoutMs?: number }),
        abortSignal: perCandidateAbort,
        responseFormat: opts.responseFormat,
      };

      let reserved = toolsTokens;
      let triedTrim = false;
      for (;;) {

        const fitted = fitMessages(messages, inputBudget(model?.contextWindow, maxOut, reserved)).messages;
        const t0 = Date.now();
        // Start the TTFT timer for this attempt: if no chunk arrives within ttftMs, the composite
        // abort signal fires and the stream loop below throws → failover. Cleared on first chunk.
        let ttftTimer: ReturnType<typeof setTimeout> | undefined;
        if (ttftController) ttftTimer = setTimeout(() => ttftController.abort(), ttftMs);
        try {
          let response: ChatCompletionResponse;

          // Attempt starting on this candidate — the hedge race watches this to exclude the
          // primary's CURRENT model, not just its already-failed ones.
          opts._onCandidateStart?.(entry.platform, entry.modelId);
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
            // Real finish_reason from the provider's final SSE chunk. The closing chunk often
            // carries ONLY finish_reason (no delta); if we never capture it, a length-truncated
            // turn (model ran out of tokens mid-answer) is silently misreported as a clean 'stop'.
            let streamFinishReason: string | undefined;
            const thinkStrip = new ThinkStripper();
            // Inline tool-call suppression: weak models (e.g. Cloudflare llama) emit a tool call as
            // plain content text ({"type":"function",...}) when they don't speak the tools API. To
            // avoid streaming that JSON blob into the chat bubble, hold back text that LOOKS like a
            // tool call (starts with `{` while tools are offered) into a side buffer instead of
            // forwarding it live. At stream end we either rescue it as a real tool call, or flush it
            // as normal text if it turned out not to be a tool call after all.
            const toolsOffered = !!opts.tools?.length;
            let holdingToolText = false;
            // Which opener shape is being held: 'brace' = a `{` (JSON dialect), 'tag' = an XML
            // dialect (`<tool_call>` / `<function=`). The release heuristics differ (see below).
            let holdKind: 'brace' | 'tag' | null = null;
            let heldText = '';
            const flushHeld = () => {
              if (heldText) {
                if (firstChunkAt === null) firstChunkAt = Date.now();
                chunks.push(heldText);
                opts.onChunk!(heldText);
                heldText = '';
              }
            };
            // A hold that never resolves (no blank line, stream never ends because it aborted) must
            // not grow unbounded — cap how much text can be withheld from live streaming so a false
            // positive (or an abort mid-hold, see the finally-flush below) never eats a large reply.
            const MAX_HOLD_CHARS = 800;
            // A 'tag' hold hides a real tool call, not prose — and tool args (e.g. writeFile's file
            // content) can legitimately run to tens of KB. A too-small cap here truncates mid-call,
            // dumping the unfinished tag soup as visible chat text and losing the rescue entirely.
            const MAX_TAG_HOLD_CHARS = 200_000;
            let loopCompletedNormally = false;
            try {
              for await (const chunk of provider.streamChatCompletion(apiKey, fitted, entry.modelId, completionOpts)) {
                // Any chunk at all (content, reasoning, keepalive, usage-only) proves the model is
                // live and responding — clear the TTFT fast-failover timer on the first one so it
                // can't fire mid-stream. The normal timeoutMs still bounds the rest of the stream.
                if (ttftTimer) { clearTimeout(ttftTimer); ttftTimer = undefined; }
                // Same liveness signal feeds the delayed-hedge race (routeHedged): first wire
                // chunk from either the primary or the hedge claims the turn; the loser aborts.
                opts._onProviderAlive?.();
                if (chunk.usage) finalUsage = chunk.usage;
                const choice0 = chunk.choices?.[0];
                if (choice0?.finish_reason) streamFinishReason = choice0.finish_reason;
                const delta = choice0?.delta;
                if (!delta) continue;
                if (delta.content) {
                  const clean = thinkStrip.feed(delta.content);
                  if (clean) {
                    if (holdingToolText) {
                      heldText += clean;
                      // Release heuristics differ by shape. A JSON ('brace') hold can't contain a
                      // blank line, so a `\n\n` means it was prose after all — release it. An XML
                      // ('tag') dialect legitimately spans blank lines between arg pairs, so only the
                      // length cap frees it (and a tag opener is a strong enough signal that a false
                      // positive is unlikely — give it a larger cap before giving up).
                      const looksNotJson = holdKind === 'brace' && heldText.includes('\n\n');
                      const cap = holdKind === 'tag' ? MAX_TAG_HOLD_CHARS : MAX_HOLD_CHARS;
                      if (looksNotJson || heldText.length > cap) { flushHeld(); holdingToolText = false; holdKind = null; }
                    } else if (toolsOffered) {
                      // Detect a tool-call opener — either a `{` opening a line (JSON dialects), or an
                      // `<tool_call>`/`<function=` XML tag (Qwen/GLM-style dialects) anywhere in the
                      // chunk. A weak model often emits prose first ("Let me check...") then the tool
                      // syntax; the earliest opener wins. Anything before it is genuine prose and
                      // streams live; from the opener onward is held for the stream-end rescue.
                      const braceMatch = /(?:^|\n)[ \t]*\{/.exec(clean);
                      const braceIdx = braceMatch ? braceMatch.index + braceMatch[0].lastIndexOf('{') : -1;
                      // ｜+DSML｜+ matches DeepSeek's `<｜DSML｜tool_calls>`/`<｜DSML｜invoke ...>`
                      // markup — the fullwidth pipe (｜, U+FF5C) is sometimes doubled by the model
                      // (｜｜DSML｜｜), so `+` tolerates both. Without this opener, DSML text streamed
                      // straight through live (see toolArgs.ts Shape 5, which rescues it only AFTER
                      // the stream ends — too late to un-render what was already shown).
                      const tagMatch = /<tool_call>|<function=|<｜+DSML｜+(?:tool_calls|invoke)/.exec(clean);
                      const tagIdx = tagMatch ? tagMatch.index : -1;
                      let idx = -1;
                      let kind: 'brace' | 'tag' | null = null;
                      if (braceIdx >= 0 && (tagIdx < 0 || braceIdx <= tagIdx)) { idx = braceIdx; kind = 'brace'; }
                      else if (tagIdx >= 0) { idx = tagIdx; kind = 'tag'; }
                      if (idx >= 0) {
                        const pre = clean.slice(0, idx);
                        if (pre) {
                          if (firstChunkAt === null) firstChunkAt = Date.now();
                          chunks.push(pre);
                          opts.onChunk!(pre);
                        }
                        holdingToolText = true;
                        holdKind = kind;
                        heldText += clean.slice(idx);
                      } else {
                        if (firstChunkAt === null) firstChunkAt = Date.now();
                        chunks.push(clean);
                        opts.onChunk!(clean);
                      }
                    } else {
                      if (firstChunkAt === null) firstChunkAt = Date.now();
                      chunks.push(clean);
                      opts.onChunk!(clean);
                    }
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
              loopCompletedNormally = true;
            } finally {
              // The stream threw (including an abort) while text was being withheld from onChunk —
              // flush it now rather than silently discarding content the model already produced.
              if (!loopCompletedNormally && holdingToolText) flushHeld();
            }
            const tail = thinkStrip.flush();
            if (tail) {
              if (holdingToolText) { heldText += tail; }
              else { chunks.push(tail); opts.onChunk!(tail); }
            }
            // Stream ended. If we were holding potential-tool-call text and NO real tool_calls
            // arrived, the held text is still pending — the rescue in routerProvider.doStream will
            // scan `fullText` (which includes heldText via the content assembly below) and convert
            // it to a real tool-call if it matches. We do NOT flush it to onChunk here unless real
            // tool_calls arrived (in which case the held text was narration and is dropped).
            if (holdingToolText && toolCallsByIndex.size > 0) {
              heldText = ''; // real tool calls arrived — held text was narration, drop it
            }
            // Fold reasoning into the answer when the model emitted no `content` (mirrors the
            // non-streaming fold in openai-compat.normalizeChoices). Without this, a pure-reasoning
            // reply or one cut off mid-think (finish_reason: length) renders as an empty turn.
            const reasoningText = reasoningChunks.join('');
            // fullText must include heldText (the inline-tool-call JSON we held back from the live
            // stream) so the rescue in routerProvider.doStream can scan it and convert it to a real
            // tool-call. If no rescue match, heldText is flushed as normal text by flushHeld() above
            // only when real tool_calls arrived; otherwise it stays here for the rescue to consume.
            const fullText = (chunks.join('') + heldText) || reasoningText;
            const toolCalls = toolCallsByIndex.size
              ? [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc)
              : undefined;
            diagLog('router.stream-done', `${entry.platform}::${entry.modelId} fittedMsgs=${fitted.length} fittedChars=${fitted.reduce((n, mm) => n + (typeof mm.content === 'string' ? mm.content.length : 0), 0)} chunks=${chunks.length} reasoningChunks=${reasoningChunks.length} textLen=${fullText.length} folded=${!chunks.length && !!reasoningText} toolCalls=${toolCallsByIndex.size} finish=${streamFinishReason ?? 'none'} finalUsage=${JSON.stringify(finalUsage)}`);

            const promptTokens = finalUsage?.prompt_tokens ?? estimateMessagesTokens(fitted);
            const completionTokens = finalUsage?.completion_tokens ?? estimateTokens(fullText);
            const totalTokens = finalUsage?.total_tokens ?? promptTokens + completionTokens;
            response = {
              id: `chatcmpl-stream-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: entry.modelId,
              choices: [{ index: 0, message: { role: 'assistant', content: fullText, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: streamFinishReason ?? 'stop' }],
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
          // A gateway can return content that is non-empty by `!x` (a stray zero-width space,
          // BOM, or other invisible character survives stripThinkTags's .trim()) but has no
          // actual answer in it — that used to sail past this guard as a "successful" turn
          // rendered as a blank reply with 0/0 usage. Strip invisible/zero-width characters
          // before judging emptiness so those are caught the same as a truly empty string.
          const INVISIBLE_CHARS = /[​-‏‪-‮⁠﻿؜]/g;
          const visibleContent = typeof responseContent === 'string'
            ? responseContent.replace(INVISIBLE_CHARS, '').trim()
            : responseContent;
          if (!visibleContent && !hasToolCalls) {
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
          // Turn-telemetry sink (see RouteOptions.onUsage): every successful call reports its
          // provider-measured usage; the last call's prompt tokens + serving window describe
          // current context pressure.
          opts.onUsage?.({
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
            contextTokens: response.usage?.prompt_tokens ?? 0,
            contextWindow: model?.contextWindow ?? undefined,
            model: `${entry.platform}/${entry.modelId}`,
          });
          this.usageStore?.addRequest(entry.platform, entry.modelId, response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, response.usage?.reasoning_tokens);
          this.secrets.setStatus(entry.platform, 'healthy');
          this.markHealth(entry.platform, entry.modelId, 'ok');
          // Serving recency for tied-band rotation (ScoringEngine.rank) — recorded for every
          // success regardless of taskKind, so the least-recently-served peer calculation
          // spans all traffic, not just one label.
          this.lastServedAt.set(`${entry.platform}::${entry.modelId}`, Date.now());

          if (opts.taskKind) {
            const modelKey2 = `${entry.platform}::${entry.modelId}`;
            // Baseline-relative: a success that ran well above the model's own baseline must
            // not (re)pin itself as lastGood — drop a stale pin so the next turn re-evaluates
            // instead of repeating a slow pick. Falls back to the fixed threshold w/o metrics.
            const slow = this.slowModels?.isSlow(entry.platform, entry.modelId) ?? false;
            if (!slow) {
              this.lastGood.set(opts.taskKind, modelKey2);
              if (opts.sessionId) this.setSessionPin(opts.sessionId, modelKey2);
            } else if (this.lastGood.get(opts.taskKind) === modelKey2) {
              this.lastGood.delete(opts.taskKind);
              // A slow model loses the session seat too, not just the taskKind one — otherwise
              // stickiness would lock a conversation onto the model that made it slow.
              if (opts.sessionId && this.sessionPin.get(opts.sessionId) === modelKey2) {
                this.sessionPin.delete(opts.sessionId);
              }
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
          // Cassette recording (TIERMUX_RECORD_CASSETTE): snapshot the raw winning response
          // with enough context (taskKind, offered tools, last role) to replay it offline as a
          // mock fixture — record a real session once, test it forever without tokens.
          getCassetteRecorder()?.record({
            taskKind: opts.taskKind,
            tools: opts.tools?.map((t) => t.function.name),
            lastRole: messages[messages.length - 1]?.role,
            response,
          });
          return { response, platform: entry.platform, model: entry.modelId, runtimeName: (provider as any).runtimeName };
        } catch (err) {
          if (ttftTimer) { clearTimeout(ttftTimer); ttftTimer = undefined; }
          // Lost the delayed-hedge race (routeHedged): the sibling request is already streaming
          // to the user. Exit QUIETLY — no markHealth, no negative metrics, no retry waits. This
          // model wasn't broken, it was merely slower than its peer; penalizing it would bench a
          // healthy candidate for 60s+ on every hedge.
          if (opts._hedgeLostSignal?.aborted) {
            failures.push({ platform: entry.platform, model: entry.modelId, reason: 'hedged_away' });
            break candidates;
          }
          let { reason, failoverable, retryAfterMs, detail } = classify(err);
          // If our own TTFT fast-failover timer aborted this candidate (no chunk within ttftMs),
          // label it as a timeout rather than a generic network error — it's more accurate and
          // routes through the existing timeout health/metric handling.
          if (reason === 'network' && ttftController?.signal.aborted) {
            reason = 'timeout';
            detail = detail ? `ttft timeout: ${detail}` : 'ttft timeout (no first chunk in time)';
          }
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

function vscodeConfigBoolean(key: string, fallback: boolean): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as typeof import('vscode');
    const dot = key.lastIndexOf('.');
    return vscode.workspace.getConfiguration(key.slice(0, dot)).get<boolean>(key.slice(dot + 1), fallback);
  } catch {
    return fallback;
  }
}

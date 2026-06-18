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
import type { ModelStatsStore } from '../config/modelStats';

export interface RouteOptions extends CompletionOptions {
  /** Force a specific model (platform::modelId or 'auto'). */
  model?: string;
  /** Only consider tool-capable models (agent mode). */
  requireTools?: boolean;
  /** When the model is "Auto", order candidates by what this task needs. */
  taskKind?: TaskKind;
  /** Notified each time the router fails over to the next model. */
  onFailover?: (info: { from: FallbackEntry; reason: string }) => void;
}

export interface RouteResult {
  response: ChatCompletionResponse;
  platform: Platform;
  model: string;
}

export class AllModelsFailedError extends Error {
  constructor(readonly failures: Array<{ platform: Platform; model: string; reason: string }>) {
    super(AllModelsFailedError.describe(failures));
    this.name = 'AllModelsFailedError';
  }

  private static describe(failures: Array<{ platform: Platform; model: string; reason: string }>): string {
    if (failures.length === 0) {
      return 'No enabled models are configured. Open "Manage Models & Keys" to enable a model and add an API key.';
    }
    // A lone failure is almost always a model the user explicitly forced — give
    // an actionable message (set a key / switch to Auto) instead of a code.
    if (failures.length === 1) {
      const f = failures[0];
      const who = `${f.platform}/${f.model}`;
      switch (f.reason) {
        case 'no_api_key': return `${who} needs an API key. Add one in "Manage Models & Keys", or set the model to Auto.`;
        case 'no_provider': return `${who} has no provider available. Pick another model, or set it to Auto.`;
        case 'not_found': return `${who} looks deprecated or removed by the provider. Pick another model, or set it to Auto.`;
        case 'rate_limited': return `${who} is rate-limited right now. Try again shortly, or set the model to Auto for automatic failover.`;
        case 'auth': return `${who} rejected the API key. Update it in "Manage Models & Keys".`;
        default: return `${who} failed (${f.reason}). Try again, or set the model to Auto.`;
      }
    }
    return `All ${failures.length} model(s) failed: ` + failures.map((f) => `${f.platform}/${f.model} (${f.reason})`).join(', ');
  }
}

function classify(err: unknown): { reason: string; failoverable: boolean; retryAfterMs?: number } {
  if (err instanceof ProviderHttpError) {
    const s = err.status;
    const retryAfterMs = err.retryAfterMs;
    if (s === 429) return { reason: 'rate_limited', failoverable: true, retryAfterMs };
    if (s === 401 || s === 403) return { reason: 'auth', failoverable: true };
    if (s === 408) return { reason: 'timeout', failoverable: true };
    if (s === 413) return { reason: 'http_413', failoverable: true };
    if (s === 404) return { reason: 'not_found', failoverable: true };
    if (s === 400) return { reason: 'bad_request', failoverable: true };
    if (s && s >= 500) return { reason: 'server_error', failoverable: true };
    return { reason: `http_${s ?? '?'}`, failoverable: true };
  }
  // Network errors (fetch TypeError) and anything else: try the next model.
  return { reason: 'network', failoverable: true };
}

export class Router {
  /** Last model (platform::modelId) that succeeded for each task kind — tried first next time. */
  private lastGood = new Map<TaskKind, string>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly settings: SettingsStore,
    private readonly catalog: Catalog,
    private readonly usage: UsageTracker,
    private readonly stats?: ModelStatsStore,
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
    const ready = async (platform: Platform): Promise<boolean> =>
      this.secrets.cooldownRemaining(platform) === 0 && (await this.secrets.resolveKey(platform)) !== undefined;
    const pick = async (keys: string[]): Promise<string | undefined> => {
      for (const key of keys) {
        if (enabled.has(key) && (await ready(key.split('::')[0] as Platform))) return key;
      }
      return undefined;
    };

    // 0. Explicit user choice (Settings → Others) wins when it's usable.
    const chosen = vscodeConfigString('tiermux.utilityModel', 'auto');
    if (chosen && chosen !== 'auto' && (await ready(chosen.split('::')[0] as Platform))) return chosen;

    // 1. Strong KEYLESS models — the default, so titles/commits work with no API key.
    const keyless = await pick(['ovh::gpt-oss-120b', 'ovh::Meta-Llama-3_3-70B-Instruct', 'pollinations::openai-fast']);
    if (keyless) return keyless;

    // 2. Curated strong keyed models, if the user added a key.
    const keyed = await pick([
      'google::gemini-2.5-flash',
      'google::gemini-2.0-flash',
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
      .sort((a, b) => a.m.intelligenceRank - b.m.intelligenceRank || a.m.speedRank - b.m.speedRank);
    for (const { e } of ranked) {
      if (await ready(e.platform)) return `${e.platform}::${e.modelId}`;
    }

    return undefined; // nothing keyed → caller falls back to Auto
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

  async route(messages: ChatMessage[], opts: RouteOptions = {}): Promise<RouteResult> {
    const failures: Array<{ platform: Platform; model: string; reason: string }> = [];
    const maxOut = opts.max_tokens ?? 4096;
    // The tool manifest is appended to every request but isn't part of the
    // trimmed message list — reserve budget for it so we don't 413.
    const sentTools = !!(opts.tools && opts.tools.length);
    const toolsTokens = sentTools ? estimateTokens(JSON.stringify(opts.tools)) : 0;

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
    }

    candidates: for (const entry of cands) {
      const provider = resolveProvider(entry.platform, this.settings.getEndpoint(entry.platform));
      if (!provider) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: 'no_provider' });
        continue;
      }
      const key = await this.secrets.resolveKey(entry.platform);
      if (key === undefined) {
        failures.push({ platform: entry.platform, model: entry.modelId, reason: 'no_api_key' });
        continue;
      }

      const model: CatalogModel | undefined = this.catalog.find(entry.platform, entry.modelId);
      const completionOpts: CompletionOptions = {
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        top_p: opts.top_p,
        tools: opts.tools,
        tool_choice: opts.tool_choice,
        parallel_tool_calls: opts.parallel_tool_calls,
        reasoningEffort: model?.supportsReasoning ? opts.reasoningEffort : undefined,
        baseUrlOverride: this.settings.getEndpoint(entry.platform),
        timeoutMs: opts.timeoutMs ?? this.timeoutMs(),
      };

      let reserved = toolsTokens;
      let triedTrim = false;
      for (;;) {
        // Trim the conversation to fit this model's context window.
        const fitted = fitMessages(messages, inputBudget(model?.contextWindow, maxOut, reserved)).messages;
        try {
          const response = await provider.chatCompletion(key, fitted, entry.modelId, completionOpts);
          this.usage.add(response.usage);
          this.secrets.setStatus(entry.platform, 'healthy');
          // Remember the winner so the next same-kind task starts here, not at the top of the cascade.
          if (opts.taskKind) this.lastGood.set(opts.taskKind, `${entry.platform}::${entry.modelId}`);
          return { response, platform: entry.platform, model: entry.modelId };
        } catch (err) {
          const { reason, failoverable, retryAfterMs } = classify(err);

          // Payload too large with tools: retry this same model once with a
          // tighter budget before failing over.
          if (reason === 'http_413' && sentTools && !triedTrim) {
            triedTrim = true;
            reserved = toolsTokens * 2 + 1024;
            continue;
          }

          if (reason === 'rate_limited') {
            this.secrets.setCooldown(entry.platform, retryAfterMs ?? this.rateLimitCooldownMs());
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

          failures.push({ platform: entry.platform, model: entry.modelId, reason });
          opts.onFailover?.({ from: entry, reason });
          if (!failoverable) break candidates;
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

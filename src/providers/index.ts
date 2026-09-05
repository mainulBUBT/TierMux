import type { Platform, PlatformInfo, CustomEndpoint } from '../shared/types';
import type { BaseProvider } from './base';
import { GoogleProvider } from './google';
import { CloudflareProvider } from './cloudflare';
import { OpenAICompatProvider, type OpenAICompatOpts } from './openai-compat';
import { OpenAIResponsesProvider } from './openai-responses';
import { AnthropicMessagesProvider } from './anthropic-messages';

/** Session cache for custom endpoint providers. Cleared on endpoint edit/remove. */
const customProviderCache = new Map<string, BaseProvider>();

const COMPAT: Array<OpenAICompatOpts & { keyUrl?: string }> = [
  { platform: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { platform: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai' },
  { platform: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', forceSingleToolCall: true, keyUrl: 'https://build.nvidia.com' },
  { platform: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { platform: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', reasoningStyle: 'openrouter', extraHeaders: { 'HTTP-Referer': 'https://github.com/mainulBUBT/TierMux', 'X-Title': 'tiermux' }, keyUrl: 'https://openrouter.ai/keys' },
  // GitHub Models retired 2026-07-30 (models.github.ai → HTTP 410, verified 2026-08-20). Do not
  // re-add from an old README.
  { platform: 'zhipu', name: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn' },
  { platform: 'huggingface', name: 'HuggingFace Router', baseUrl: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens' },
  { platform: 'ollama', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', timeoutMs: 120000, skipPreflight: true, keyUrl: 'https://ollama.com/settings/keys' },
  { platform: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://api.kilo.ai/api/gateway/v1', keyless: true },
  { platform: 'pollinations', name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai/v1', keyless: true, skipPreflight: true },
  { platform: 'llm7', name: 'LLM7', baseUrl: 'https://api.llm7.io/v1', keyUrl: 'https://llm7.io' },
  { platform: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', keyless: true, skipPreflight: true, keyUrl: 'https://opencode.ai/auth' },
  { platform: 'ovh', name: 'OVH AI Endpoints', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', keyless: true },
  { platform: 'agnes', name: 'Agnes AI', baseUrl: 'https://apihub.agnes-ai.com/v1', timeoutMs: 120000, skipPreflight: true, keyUrl: 'https://platform.agnes-ai.com' },
  { platform: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', keyUrl: 'https://cloud.sambanova.ai/apis' },
  { platform: 'siliconflow', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { platform: 'zenmux', name: 'ZenMux', baseUrl: 'https://zenmux.ai/api/v1', timeoutMs: 30000, skipPreflight: true, reasoningStyle: 'openrouter', extraHeaders: { 'HTTP-Referer': 'https://github.com/mainulBUBT/TierMux', 'X-Title': 'tiermux' }, keyUrl: 'https://zenmux.ai/dashboard/keys' },
  { platform: 'kenari', name: 'Kenari', baseUrl: 'https://kenari.id/v1', skipPreflight: true, keyUrl: 'https://kenari.id' },
  { platform: 'llmgateway', name: 'LLM Gateway', baseUrl: 'https://api.llmgateway.io/v1', keyUrl: 'https://llmgateway.io' },
  // defaultMaxTokens: thinking is always on and shares the output budget with the
  // answer — an unset/small max_tokens lets it exhaust the budget mid-<think>, which
  // ThinkStripper correctly discards, producing an empty (but billed) turn.
  { platform: 'poolside', name: 'Poolside', baseUrl: 'https://inference.poolside.ai/v1', timeoutMs: 120000, skipPreflight: true, defaultMaxTokens: 8192, keyUrl: 'https://poolside.ai' },
  { platform: 'nararouter', name: "Nara Router", baseUrl: "https://router.bynara.id/v1", skipPreflight: true, timeoutMs: 600000 }, // auto-synced
  { platform: 'aionlabs', name: "Aion Labs", baseUrl: "https://api.aionlabs.ai/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://www.aionlabs.ai/accounts/login/" }, // auto-synced
  { platform: 'chatanywhere', name: "ChatAnywhere", baseUrl: "https://api.chatanywhere.org/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://chatanywhere.tech/" }, // auto-synced
  { platform: 'openadapter', name: "OpenAdapter", baseUrl: "https://api.openadapter.in/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://dashboard.openadapter.in/" }, // auto-synced
  { platform: 'orcarouter', name: "OrcaRouter", baseUrl: "https://api.orcarouter.ai/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://www.orcarouter.ai/" }, // auto-synced
  { platform: 'requesty', name: "Requesty", baseUrl: "https://router.requesty.ai/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://app.requesty.ai/sign-up" }, // auto-synced
  { platform: 'router9', name: "Router9", baseUrl: "https://api.router9.com/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://www.router9.com/login" }, // auto-synced
  { platform: 'xkiro', name: "xKiro", baseUrl: "https://api.xkiro.com/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://xkiro.com/dashboard/api/keys" }, // auto-synced
  { platform: 'airforce', name: "Api.Airforce", baseUrl: "https://api.airforce/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://api.airforce/" }, // auto-synced
  { platform: 'modelscope', name: "ModelScope", baseUrl: "https://api-inference.modelscope.cn/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://modelscope.cn/my/myaccesstoken" }, // auto-synced
  { platform: 'tokenrouter', name: "Token Router", baseUrl: "https://api.tokenrouter.com/v1", skipPreflight: true, timeoutMs: 600000 }, // auto-synced
  { platform: 'experientiallabs', name: "Experiential Labs", baseUrl: "https://api.experientiallabs.ai/v1", skipPreflight: true, timeoutMs: 600000, keyUrl: "https://platform.experientiallabs.ai/settings" }, // auto-synced
];

const providers = new Map<Platform, BaseProvider>();
const platformInfo = new Map<Platform, PlatformInfo>();
/** Original registration opts for each compat provider, so a remote base-URL update
 *  can re-register without wiping curated flags (extraHeaders, reasoningStyle, …). */
const compatOpts = new Map<Platform, OpenAICompatOpts & { keyUrl?: string }>();

function registerCompat(opts: OpenAICompatOpts & { keyUrl?: string }) {
  compatOpts.set(opts.platform, opts);
  providers.set(opts.platform, new OpenAICompatProvider(opts));
  platformInfo.set(opts.platform, {
    platform: opts.platform,
    name: opts.name,
    defaultBaseUrl: opts.baseUrl,
    keyless: opts.keyless ?? false,
    keyOptional: opts.keyOptional ?? false,
    keyUrl: opts.keyUrl,
  });
}

const googleProvider = new GoogleProvider();
googleProvider.skipPreflight = true;
providers.set('google', googleProvider);
platformInfo.set('google', { platform: 'google', name: 'Google AI Studio', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyless: false, keyUrl: 'https://aistudio.google.com/apikey' });

registerCompat({ platform: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', flattenContent: true, keyUrl: 'https://dashboard.cohere.com/api-keys' });

providers.set('cloudflare', new CloudflareProvider());
platformInfo.set('cloudflare', { platform: 'cloudflare', name: 'Cloudflare Workers AI', defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1', keyless: false, keyUrl: 'https://dash.cloudflare.com/profile/api-tokens' });

for (const c of COMPAT) registerCompat(c);

// Custom/local endpoints run with NO request timeout (2026-08-23, user direction): a
// CPU-bound local model takes as long as it takes, the Stop button is the only brake, and
// there is no faster pool to fail over to.
const CUSTOM_TIMEOUT_MS = 0;
const CUSTOM_TTFT_MS = 0;

export function resolveProvider(
  platform: Platform,
  modelId?: string,
  customEndpoints?: CustomEndpoint[],
): BaseProvider | undefined {
  if (platform === 'custom') {
    if (!modelId || !customEndpoints) return undefined;
    const epId = modelId.split('::')[0];
    const endpoint = customEndpoints.find((ep) => ep.id === epId);
    if (!endpoint) return undefined;

    if (customProviderCache.has(epId)) return customProviderCache.get(epId);

    const commonOpts = {
      platform: 'custom' as const,
      name: endpoint.name,
      runtimeName: endpoint.name,
      baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
      extraHeaders: endpoint.extraHeaders,
      timeoutMs: CUSTOM_TIMEOUT_MS,
      ttftTimeoutMs: CUSTOM_TTFT_MS,
      skipPreflight: true,
    };
    // Undefined type = 'openai-chat' — the only shape every endpoint saved before this field
    // existed already speaks, so it stays the default rather than needing a migration.
    const provider: BaseProvider =
      endpoint.type === 'anthropic-messages' ? new AnthropicMessagesProvider(commonOpts)
      : endpoint.type === 'openai-responses' ? new OpenAIResponsesProvider(commonOpts)
      : new OpenAICompatProvider(commonOpts);
    customProviderCache.set(epId, provider);
    return provider;
  }
  return providers.get(platform);
}

/** Clear the cached provider for an endpoint (call on edit/remove). */
export function invalidateCustomProvider(id: string): void {
  customProviderCache.delete(id);
}

export function getPlatformInfo(platform: Platform): PlatformInfo | undefined {
  return platformInfo.get(platform);
}

export function allPlatformInfo(): PlatformInfo[] {
  return Array.from(platformInfo.values());
}

/** A provider definition advertised by the remote catalog. `baseUrl` is required to
 *  act; the rest is optional polish. `platform` may be a built-in id or a brand-new one. */
export interface RemoteProviderDef {
  platform: string;
  baseUrl?: string;
  name?: string;
  keyUrl?: string;
  keyless?: boolean;
}

/** Merge remote-catalog provider definitions into the registry: new platforms become an
 *  OpenAI-compat provider, existing compat providers get base URL/key/keyless/name refreshed,
 *  dedicated implementations (Google, Cloudflare) are never touched. Returns the count of real
 *  changes so callers can skip noisy "changed" notifications. */
export function upsertCompatFromCatalog(defs: RemoteProviderDef[]): number {
  let applied = 0;
  for (const d of defs) {
    if (!d.platform || !d.baseUrl) continue;
    const platform = d.platform as Platform;
    const existing = providers.get(platform);
    if (existing && !(existing instanceof OpenAICompatProvider)) continue; // keep dedicated impls
    const prev = platformInfo.get(platform);
    // Skip when nothing actually differs from what's already registered.
    const sameBaseUrl = prev?.defaultBaseUrl === d.baseUrl;
    const sameName = !d.name || prev?.name === d.name;
    const sameKeyless = d.keyless === undefined || prev?.keyless === d.keyless;
    const sameKeyUrl = !d.keyUrl || prev?.keyUrl === d.keyUrl;
    if (prev && sameBaseUrl && sameName && sameKeyless && sameKeyUrl) continue;

    const base = compatOpts.get(platform);
    const opts: OpenAICompatOpts & { keyUrl?: string } = base
      ? {
          ...base,
          baseUrl: d.baseUrl,
          ...(d.name ? { name: d.name } : {}),
          ...(d.keyless !== undefined ? { keyless: d.keyless } : {}),
          ...(d.keyUrl ? { keyUrl: d.keyUrl } : {}),
        }
      : {
          platform,
          name: d.name ?? platform,
          baseUrl: d.baseUrl,
          keyless: d.keyless ?? false,
          skipPreflight: true,
          timeoutMs: CUSTOM_TIMEOUT_MS,
          ...(d.keyUrl ? { keyUrl: d.keyUrl } : {}),
        };
    registerCompat(opts);
    applied++;
  }
  return applied;
}

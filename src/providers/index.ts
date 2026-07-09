import type { Platform, PlatformInfo, CustomEndpoint } from '../shared/types';
import type { BaseProvider } from './base';
import { GoogleProvider } from './google';
import { CloudflareProvider } from './cloudflare';
import { OpenAICompatProvider, type OpenAICompatOpts } from './openai-compat';

/** Session cache for custom endpoint providers. Cleared on endpoint edit/remove. */
const customProviderCache = new Map<string, BaseProvider>();

const COMPAT: Array<OpenAICompatOpts & { keyUrl?: string }> = [
  { platform: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { platform: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai' },
  { platform: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', forceSingleToolCall: true, keyUrl: 'https://build.nvidia.com' },
  { platform: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { platform: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', reasoningStyle: 'openrouter', extraHeaders: { 'HTTP-Referer': 'https://github.com/tashfeenahmed/freellmapi', 'X-Title': 'tiermux' }, keyUrl: 'https://openrouter.ai/keys' },
  { platform: 'github', name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', skipPreflight: true, keyUrl: 'https://github.com/settings/tokens' },
  { platform: 'zhipu', name: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn' },
  { platform: 'huggingface', name: 'HuggingFace Router', baseUrl: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens' },
  { platform: 'ollama', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', timeoutMs: 120000, skipPreflight: true, keyUrl: 'https://ollama.com/settings/keys' },
  { platform: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://api.kilo.ai/api/gateway/v1', keyless: true },
  { platform: 'pollinations', name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai/v1', keyless: true },
  { platform: 'llm7', name: 'LLM7', baseUrl: 'https://api.llm7.io/v1', keyUrl: 'https://llm7.io' },
  { platform: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', keyUrl: 'https://opencode.ai/auth' },
  { platform: 'ovh', name: 'OVH AI Endpoints', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', keyless: true },
  { platform: 'agnes', name: 'Agnes AI', baseUrl: 'https://apihub.agnes-ai.com/v1', timeoutMs: 120000, skipPreflight: true, keyUrl: 'https://platform.agnes-ai.com' },
  { platform: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', keyUrl: 'https://cloud.sambanova.ai/apis' },
  { platform: 'siliconflow', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { platform: 'zenmux', name: 'ZenMux', baseUrl: 'https://zenmux.ai/api/v1', timeoutMs: 30000, skipPreflight: true, reasoningStyle: 'openrouter', extraHeaders: { 'HTTP-Referer': 'https://github.com/tashfeenahmed/freellmapi', 'X-Title': 'tiermux' }, keyUrl: 'https://zenmux.ai/dashboard/keys' },
  { platform: 'kenari', name: 'Kenari', baseUrl: 'https://kenari.id/v1', skipPreflight: true, keyUrl: 'https://kenari.id' },
  { platform: 'llmgateway', name: 'LLM Gateway', baseUrl: 'https://api.llmgateway.io/v1', keyUrl: 'https://llmgateway.io' },
];

const providers = new Map<Platform, BaseProvider>();
const platformInfo = new Map<Platform, PlatformInfo>();

function registerCompat(opts: OpenAICompatOpts & { keyUrl?: string }) {
  providers.set(opts.platform, new OpenAICompatProvider(opts));
  platformInfo.set(opts.platform, {
    platform: opts.platform,
    name: opts.name,
    defaultBaseUrl: opts.baseUrl,
    keyless: opts.keyless ?? false,
    keyUrl: opts.keyUrl,
  });
}

// Google (Gemini) — bespoke adapter.
const googleProvider = new GoogleProvider();
googleProvider.skipPreflight = true;
providers.set('google', googleProvider);
platformInfo.set('google', { platform: 'google', name: 'Google AI Studio', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyless: false, keyUrl: 'https://aistudio.google.com/apikey' });

// Cohere — OpenAI-compatible via the compatibility endpoint (flatten content).
registerCompat({ platform: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', flattenContent: true, keyUrl: 'https://dashboard.cohere.com/api-keys' });

// Cloudflare Workers AI — bespoke (account_id:token key).
providers.set('cloudflare', new CloudflareProvider());
platformInfo.set('cloudflare', { platform: 'cloudflare', name: 'Cloudflare Workers AI', defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1', keyless: false, keyUrl: 'https://dash.cloudflare.com/profile/api-tokens' });

for (const c of COMPAT) registerCompat(c);

// No built-in 'custom' platformInfo — custom endpoints are user-defined.

const CUSTOM_TIMEOUT_MS = 120000;

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
    // Check cache first.
    if (customProviderCache.has(epId)) return customProviderCache.get(epId);
    // Build and cache a new provider.
    const provider = new OpenAICompatProvider({
      platform: 'custom',
      name: endpoint.name,
      runtimeName: endpoint.name,
      baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
      extraHeaders: endpoint.extraHeaders,
      timeoutMs: CUSTOM_TIMEOUT_MS,
      // Skip the 2s preflight ping for user-configured endpoints. Custom/self-hosted
      // models are often slow on first response, so the ping aborts and gets the model
      // wrongly marked dead (cached 60s) before the real request — the dominant cause of
      // "custom endpoint times out instantly". A custom model is a single forced pick with
      // no failover chain, so preflight buys nothing; the real request runs with the full
      // CUSTOM_TIMEOUT_MS budget instead. Matches how Cline/Kilo treat custom providers.
      skipPreflight: true,
    });
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

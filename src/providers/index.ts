// Provider registry. Base URLs/headers/keyless flags ported from freellmapi's
// server/src/providers/index.ts (MIT). The `custom` platform builds a provider
// bound to a user-supplied base URL.
import type { Platform, PlatformInfo } from '../shared/types';
import type { BaseProvider } from './base';
import { GoogleProvider } from './google';
import { CloudflareProvider } from './cloudflare';
import { OpenAICompatProvider, type OpenAICompatOpts } from './openai-compat';

const COMPAT: Array<OpenAICompatOpts & { keyUrl?: string }> = [
  { platform: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { platform: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai' },
  { platform: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', forceSingleToolCall: true, keyUrl: 'https://build.nvidia.com' },
  { platform: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { platform: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', reasoningStyle: 'openrouter', extraHeaders: { 'HTTP-Referer': 'https://github.com/tashfeenahmed/freellmapi', 'X-Title': 'tiermux' }, keyUrl: 'https://openrouter.ai/keys' },
  { platform: 'github', name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', keyUrl: 'https://github.com/settings/tokens' },
  { platform: 'zhipu', name: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn' },
  { platform: 'huggingface', name: 'HuggingFace Router', baseUrl: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens' },
  { platform: 'ollama', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', timeoutMs: 120000, keyUrl: 'https://ollama.com/settings/keys' },
  { platform: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://api.kilo.ai/api/gateway/v1', keyless: true },
  { platform: 'pollinations', name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai/v1', keyless: true },
  { platform: 'llm7', name: 'LLM7', baseUrl: 'https://api.llm7.io/v1', keyUrl: 'https://llm7.io' },
  { platform: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', keyUrl: 'https://opencode.ai/auth' },
  { platform: 'ovh', name: 'OVH AI Endpoints', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', keyless: true },
  { platform: 'agnes', name: 'Agnes AI', baseUrl: 'https://apihub.agnes-ai.com/v1', keyUrl: 'https://platform.agnes-ai.com' },
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
providers.set('google', new GoogleProvider());
platformInfo.set('google', { platform: 'google', name: 'Google AI Studio', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyless: false, keyUrl: 'https://aistudio.google.com/apikey' });

// Cohere — OpenAI-compatible via the compatibility endpoint (flatten content).
registerCompat({ platform: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', flattenContent: true, keyUrl: 'https://dashboard.cohere.com/api-keys' });

// Cloudflare Workers AI — bespoke (account_id:token key).
providers.set('cloudflare', new CloudflareProvider());
platformInfo.set('cloudflare', { platform: 'cloudflare', name: 'Cloudflare Workers AI', defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1', keyless: false, keyUrl: 'https://dash.cloudflare.com/profile/api-tokens' });

for (const c of COMPAT) registerCompat(c);

// Custom — built per-call from a user-supplied base URL (settings override).
platformInfo.set('custom', { platform: 'custom', name: 'Custom (OpenAI-compatible)', defaultBaseUrl: '', keyless: false });

const CUSTOM_TIMEOUT_MS = 120000;

export function resolveProvider(platform: Platform, baseUrlOverride?: string | null): BaseProvider | undefined {
  if (platform === 'custom') {
    const trimmed = baseUrlOverride?.trim();
    if (!trimmed) return undefined;
    return new OpenAICompatProvider({ platform: 'custom', name: 'Custom', baseUrl: trimmed.replace(/\/+$/, ''), timeoutMs: CUSTOM_TIMEOUT_MS });
  }
  return providers.get(platform);
}

export function getPlatformInfo(platform: Platform): PlatformInfo | undefined {
  return platformInfo.get(platform);
}

export function allPlatformInfo(): PlatformInfo[] {
  return Array.from(platformInfo.values());
}

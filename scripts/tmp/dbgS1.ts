import { Router } from '../../src/router/router';
import { MetricsStore } from '../../src/router/metricsStore';
import { ScoringEngine } from '../../src/router/scoring';
import type { SecretStore } from '../../src/config/secrets';
import type { SettingsStore } from '../../src/config/settingsStore';
import type { Catalog } from '../../src/catalog/catalog';
import type { UsageTracker } from '../../src/config/usage';
import type { CatalogModel, FallbackEntry, Platform } from '../../src/shared/types';

const READY: FallbackEntry = { platform: 'github' as Platform, modelId: 'ready-model', enabled: true, priority: 0 };
const COOL_A: FallbackEntry = { platform: 'ollama' as Platform, modelId: 'cool-a', enabled: true, priority: 1 };
const ALL = [READY, COOL_A];
const MODELS = ALL.map((e): CatalogModel => ({
  platform: e.platform, modelId: e.modelId, displayName: e.modelId,
  intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
  rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
  supportsTools: true, supportsVision: false, supportsReasoning: false,
}));
let coolMs: Record<string, number> = { ollama: 120_000 };
let requested: string[] = [];

const secrets: Partial<SecretStore> = {
  cooldownRemaining: ((p: string) => coolMs[p] ?? 0) as never,
  getModelKey: async () => undefined, resolveKey: async () => 'fake-key',
  isToolIncompatible: () => false, isDeprecated: () => false, setStatus: () => {},
  setCooldownForKey: () => {}, setCooldown: () => {}, keyCooldownRemaining: () => 0,
  getKeys: async () => ['fake-key'], markToolIncompatible: () => {}, markDeprecated: () => {},
  snapshot: async () => [],
} as SecretStore;
const settings = {
  enabledByPriority: () => ALL, getCustomEndpoints: () => [], getEndpoint: () => undefined,
} as unknown as SettingsStore;
const catalog = { find: (p: string, id: string) => MODELS.find((m) => m.platform === p && m.modelId === id) } as unknown as Catalog;
const usage = { add: () => {} } as unknown as UsageTracker;
const mem = { get: (_k: string, d?: unknown) => d, keys: () => [], update: async () => {}, setKeysForSync() {} } as import('vscode').Memento;
const metrics = new MetricsStore(mem);
const router = new Router(secrets, settings, catalog, usage, undefined, undefined, undefined, metrics, new ScoringEngine(catalog, metrics));

(globalThis as any).fetch = (async (_url: string, init?: RequestInit) => {
  let modelId = '?';
  try { modelId = JSON.parse(String(init?.body ?? '{}')).model ?? '?'; } catch {}
  requested.push(modelId);
  console.log('FETCH →', modelId);
  return { ok: true, status: 200, json: async () => ({ id: 'x', object: 'chat.completion', created: 0, model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} }) } as unknown as Response;
}) as typeof fetch;

async function main() {
  (globalThis as any).__tiermuxTestConfig = { hedging: false };
  try {
    const res = await router.route([{ role: 'user' as const, content: 'hi' }], { taskKind: 'chat',
      onFailover: (i) => console.log('FAILOVER:', i.from.platform + '/' + i.from.modelId, '<-', i.reason),
      onProviderAttempt: (i) => console.log('ATTEMPT:', i.platform + '/' + i.model, i.status, i.reason ?? '', i.errorType ?? ''),
      onSelectionRationale: (info) => {
      console.log('RANK:', info.rationale.map((r) => `${r.platform}/${r.modelId}:${r.selected ? '★' : ''}`).join(' > '));
    } });
    console.log('SERVED:', res.platform, res.model);
  } catch (e) { console.log('THREW:', e instanceof Error ? e.message : e); }
  
}
void main();

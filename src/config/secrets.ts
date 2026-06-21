// Per-platform API keys via VS Code SecretStorage.
import * as vscode from 'vscode';
import type { KeyStatus, Platform } from '../shared/types';
import { allPlatformInfo, getPlatformInfo } from '../providers';

const PREFIX = 'tiermux.key.';
const KEYS_PREFIX = 'tiermux.keys.';
const MODEL_KEY_PREFIX = 'tiermux.modelKey.';

function modelKeyId(platform: Platform, modelId: string): string {
  return `${platform}::${modelId}`;
}

export class SecretStore {
  private statuses = new Map<Platform, KeyStatus>();
  /** Epoch-ms until which a platform should be skipped after a rate limit. */
  private cooldownUntil = new Map<Platform, number>();
  /** Epoch-ms until which a specific API key value is in rate-limit cooldown. */
  private keyCooldownUntil = new Map<string, number>();
  /** Epoch-ms until which a `platform::modelId` is treated as tool-incompatible. */
  private toolIncompatUntil = new Map<string, number>();
  /** Epoch-ms until which a `platform::modelId` is treated as deprecated/removed (404). */
  private deprecatedUntil = new Map<string, number>();
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    secrets.onDidChange((e) => {
      if (e.key.startsWith(PREFIX)) this._onChange.fire();
    });
  }

  async get(platform: Platform): Promise<string | undefined> {
    return this.secrets.get(PREFIX + platform);
  }

  async set(platform: Platform, key: string): Promise<void> {
    const trimmed = key.trim();
    await this.secrets.store(PREFIX + platform, trimmed);
    // Mirror into the multi-key pool: add if not already present.
    const existing = await this.getKeys(platform);
    if (!existing.includes(trimmed)) {
      await this.secrets.store(KEYS_PREFIX + platform, JSON.stringify([trimmed, ...existing]));
    }
    this.statuses.set(platform, 'unknown');
  }

  async clear(platform: Platform): Promise<void> {
    await this.secrets.delete(PREFIX + platform);
    await this.secrets.delete(KEYS_PREFIX + platform);
    this.statuses.delete(platform);
  }

  // ---- multi-key pool per platform ----

  /** All stored keys for a platform (in priority order). Falls back to the single key. */
  async getKeys(platform: Platform): Promise<string[]> {
    const multiStr = await this.secrets.get(KEYS_PREFIX + platform);
    if (multiStr) {
      try { return JSON.parse(multiStr) as string[]; } catch { /* fall through */ }
    }
    const single = await this.secrets.get(PREFIX + platform);
    return single ? [single] : [];
  }

  /** Replace the key pool for a platform. Syncs the legacy single-key slot to pool[0]. */
  async setKeys(platform: Platform, keys: string[]): Promise<void> {
    const trimmed = keys.map((k) => k.trim()).filter(Boolean);
    await this.secrets.store(KEYS_PREFIX + platform, JSON.stringify(trimmed));
    if (trimmed.length > 0) await this.secrets.store(PREFIX + platform, trimmed[0]);
    else await this.secrets.delete(PREFIX + platform);
    this.statuses.set(platform, 'unknown');
    this._onChange.fire();
  }

  /** Append a key to the pool (no-op if already present). */
  async addKey(platform: Platform, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) return;
    const existing = await this.getKeys(platform);
    if (!existing.includes(trimmed)) await this.setKeys(platform, [...existing, trimmed]);
  }

  /** Remove a specific key from the pool. */
  async removeKey(platform: Platform, key: string): Promise<void> {
    const existing = await this.getKeys(platform);
    await this.setKeys(platform, existing.filter((k) => k !== key));
  }

  /** Cool a specific API key value (not the whole platform). */
  setCooldownForKey(key: string, ms: number): void {
    this.keyCooldownUntil.set(key, Date.now() + Math.max(0, ms));
  }

  /** Milliseconds left on a specific key's rate-limit cooldown (0 if ready). */
  keyCooldownRemaining(key: string): number {
    return Math.max(0, (this.keyCooldownUntil.get(key) ?? 0) - Date.now());
  }

  /** Masked display hints for each stored key, safe to send to the webview. */
  async getKeyHints(platform: Platform): Promise<string[]> {
    const keys = await this.getKeys(platform);
    return keys.map((k) => {
      if (k.length <= 8) return '••••' + k.slice(-4);
      return k.slice(0, 4) + '••••' + k.slice(-4);
    });
  }

  /**
   * Return the first key in the pool that is not in per-key cooldown.
   * Returns undefined when all keys are cooled (caller should then cool the
   * whole platform and fail over to the next provider).
   */
  async getNextAvailableKey(platform: Platform): Promise<string | undefined> {
    const info = getPlatformInfo(platform);
    if (info?.keyless) return '';
    const keys = await this.getKeys(platform);
    for (const k of keys) {
      if (this.keyCooldownRemaining(k) === 0) return k;
    }
    return undefined; // all keys cooled
  }

  // ---- per-model API keys (override the platform key) ----

  async getModelKey(platform: Platform, modelId: string): Promise<string | undefined> {
    return this.secrets.get(MODEL_KEY_PREFIX + modelKeyId(platform, modelId));
  }

  async setModelKey(platform: Platform, modelId: string, key: string): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) return false;
    await this.secrets.store(MODEL_KEY_PREFIX + modelKeyId(platform, modelId), trimmed);
    return true;
  }

  async clearModelKey(platform: Platform, modelId: string): Promise<void> {
    await this.secrets.delete(MODEL_KEY_PREFIX + modelKeyId(platform, modelId));
  }

  /** Snapshot of `platform::modelId` keys that are currently set, restricted to
   *  the supplied catalog. Pass the catalog so we don't scan the secret store
   *  for unknown / removed models. */
  async modelKeySnapshot(catalog: ReadonlyArray<{ platform: Platform; modelId: string }>): Promise<string[]> {
    const out: string[] = [];
    for (const m of catalog) {
      const k = await this.getModelKey(m.platform, m.modelId);
      if (k) out.push(modelKeyId(m.platform, m.modelId));
    }
    return out;
  }

  setStatus(platform: Platform, status: KeyStatus): void {
    this.statuses.set(platform, status);
    // A success clears any outstanding rate-limit penalty.
    if (status === 'healthy') this.cooldownUntil.delete(platform);
    this._onChange.fire();
  }

  /** Put a platform in a rate-limit cooldown (skip it until the window elapses). */
  setCooldown(platform: Platform, ms: number): void {
    this.cooldownUntil.set(platform, Date.now() + Math.max(0, ms));
    this.setStatus(platform, 'rate_limited');
  }

  /** Milliseconds left before a rate-limited platform is eligible again (0 if ready). */
  cooldownRemaining(platform: Platform): number {
    return Math.max(0, (this.cooldownUntil.get(platform) ?? 0) - Date.now());
  }

  /**
   * Mark a model as effectively tool-incompatible for a window — a runtime
   * override of the catalog `supportsTools` flag for models that advertise tools
   * but reject the tools payload (bad_request / 413). Time-boxed so a provider
   * fix self-heals.
   */
  markToolIncompatible(platform: Platform, modelId: string, ms = 600_000): void {
    this.toolIncompatUntil.set(`${platform}::${modelId}`, Date.now() + Math.max(0, ms));
  }

  isToolIncompatible(platform: Platform, modelId: string): boolean {
    const until = this.toolIncompatUntil.get(`${platform}::${modelId}`);
    return until !== undefined && until > Date.now();
  }

  /**
   * Mark a model as deprecated/removed (a 404 from the provider) so routing stops
   * trying it and the picker can flag it — the catalog ships stale entries over
   * time. Time-boxed (default 24h) so it self-heals if the provider re-adds it.
   */
  markDeprecated(platform: Platform, modelId: string, ms = 86_400_000): void {
    this.deprecatedUntil.set(`${platform}::${modelId}`, Date.now() + Math.max(0, ms));
    this._onChange.fire(); // refresh the config so the model picker flags it
  }

  isDeprecated(platform: Platform, modelId: string): boolean {
    const until = this.deprecatedUntil.get(`${platform}::${modelId}`);
    return until !== undefined && until > Date.now();
  }

  /** Currently-quarantined `platform::modelId` keys, for flagging in the UI. */
  deprecatedKeys(): string[] {
    const now = Date.now();
    return [...this.deprecatedUntil.entries()].filter(([, until]) => until > now).map(([k]) => k);
  }

  /** A snapshot of which platforms are configured (key present or keyless) + status. */
  async snapshot(): Promise<Array<{ platform: Platform; configured: boolean; keyless: boolean; status: KeyStatus; keyCount: number; keyHints: string[] }>> {
    const out: Array<{ platform: Platform; configured: boolean; keyless: boolean; status: KeyStatus; keyCount: number; keyHints: string[] }> = [];
    for (const info of allPlatformInfo()) {
      if (info.platform === 'custom') continue;
      const keys = await this.getKeys(info.platform);
      const configured = info.keyless || keys.length > 0;
      const hints = keys.map((k) => k.length <= 8 ? '••••' + k.slice(-4) : k.slice(0, 4) + '••••' + k.slice(-4));
      out.push({
        platform: info.platform,
        configured,
        keyless: info.keyless,
        status: this.statuses.get(info.platform) ?? (configured ? 'unknown' : 'missing'),
        keyCount: keys.length,
        keyHints: hints,
      });
    }
    return out;
  }

  /** Resolve the best available key for a platform; keyless platforms return ''.
   *  Prefers a non-cooled key; falls back to the first key if all are cooled
   *  (the router checks per-key cooldown separately and handles failover). */
  async resolveKey(platform: Platform): Promise<string | undefined> {
    const info = getPlatformInfo(platform);
    if (info?.keyless) return '';
    const next = await this.getNextAvailableKey(platform);
    if (next !== undefined) return next;
    // All keys cooled — return first key so caller surfaces the cooldown error
    // rather than treating it as "no key configured".
    const keys = await this.getKeys(platform);
    return keys[0];
  }
}

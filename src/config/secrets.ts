
import * as vscode from 'vscode';
import type { KeyStatus, Platform } from '../shared/types';
import { allPlatformInfo } from '../providers';

const PREFIX = 'tiermux.key.';
const KEYS_PREFIX = 'tiermux.keys.';
const MODEL_KEY_PREFIX = 'tiermux.modelKey.';
const CUSTOM_KEY_PREFIX = 'tiermux.key.custom.';
const CUSTOM_MODEL_KEY_PREFIX = 'tiermux.modelKey.custom.';
const CLOUDFLARE_ACCOUNT_PREFIX = 'tiermux.key.cloudflare.accountId';

function modelKeyId(platform: Platform, modelId: string): string {
  return `${platform}::${modelId}`;
}

export class SecretStore {
  private statuses = new Map<Platform, KeyStatus>();
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

  async getCustomKey(id: string): Promise<string | undefined> {
    return this.secrets.get(CUSTOM_KEY_PREFIX + id);
  }

  async setCustomKey(id: string, key: string): Promise<void> {
    const trimmed = key.trim();
    await this.secrets.store(CUSTOM_KEY_PREFIX + id, trimmed);
    this.statuses.set('custom' as Platform, 'unknown');
  }

  async clearCustomKey(id: string): Promise<void> {
    await this.secrets.delete(CUSTOM_KEY_PREFIX + id);
  }

  async getCustomModelKey(id: string, upstreamModelId: string): Promise<string | undefined> {
    return this.secrets.get(CUSTOM_MODEL_KEY_PREFIX + id + '::' + upstreamModelId);
  }

  async setCustomModelKey(id: string, upstreamModelId: string, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) return;
    await this.secrets.store(CUSTOM_MODEL_KEY_PREFIX + id + '::' + upstreamModelId, trimmed);
  }

  async clearCustomModelKey(id: string, upstreamModelId: string): Promise<void> {
    await this.secrets.delete(CUSTOM_MODEL_KEY_PREFIX + id + '::' + upstreamModelId);
  }

  async getCloudflareAccountId(): Promise<string | undefined> {
    return this.secrets.get(CLOUDFLARE_ACCOUNT_PREFIX);
  }

  async setCloudflareAccountId(accountId: string): Promise<void> {
    const trimmed = accountId.trim();
    if (!trimmed) return;
    await this.secrets.store(CLOUDFLARE_ACCOUNT_PREFIX, trimmed);
    this._onChange.fire();
  }

  async clearCloudflareAccountId(): Promise<void> {
    await this.secrets.delete(CLOUDFLARE_ACCOUNT_PREFIX);
    this._onChange.fire();
  }

  /** Masked display hint for the Cloudflare account ID (safe for webview). */
  async getCloudflareAccountIdHint(): Promise<string | undefined> {
    const id = await this.secrets.get(CLOUDFLARE_ACCOUNT_PREFIX);
    if (!id) return undefined;
    if (id.length <= 8) return '••••' + id.slice(-4);
    return id.slice(0, 4) + '••••' + id.slice(-4);
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

    this._onChange.fire();
  }

  /** Time-boxed runtime override of the catalog `supportsTools` flag for a model that rejected
   *  the tools payload (400/413). Set by picker.noteModelFailure. */
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
  async snapshot(): Promise<Array<{ platform: Platform; configured: boolean; keyless: boolean; status: KeyStatus; keyCount: number; keyHints: string[]; cloudflareAccountId?: string }>> {
    const out: Array<{ platform: Platform; configured: boolean; keyless: boolean; status: KeyStatus; keyCount: number; keyHints: string[]; cloudflareAccountId?: string }> = [];
    const cfAccountId = await this.getCloudflareAccountIdHint();
    for (const info of allPlatformInfo()) {
      if (info.platform === 'custom') continue;
      const keys = await this.getKeys(info.platform);
      const configured = info.keyless || keys.length > 0 || (info.platform === 'cloudflare' && !!cfAccountId);
      const hints = keys.map((k) => k.length <= 8 ? '••••' + k.slice(-4) : k.slice(0, 4) + '••••' + k.slice(-4));
      out.push({
        platform: info.platform,
        configured,
        keyless: info.keyless,
        status: this.statuses.get(info.platform) ?? (configured ? 'unknown' : 'missing'),
        keyCount: keys.length,
        keyHints: hints,
        ...(info.platform === 'cloudflare' ? { cloudflareAccountId: cfAccountId } : {}),
      });
    }
    return out;
  }

}

// Per-platform API keys via VS Code SecretStorage.
import * as vscode from 'vscode';
import type { KeyStatus, Platform } from '../shared/types';
import { allPlatformInfo, getPlatformInfo } from '../providers';

const PREFIX = 'tiermux.key.';

export class SecretStore {
  private statuses = new Map<Platform, KeyStatus>();
  /** Epoch-ms until which a platform should be skipped after a rate limit. */
  private cooldownUntil = new Map<Platform, number>();
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
    await this.secrets.store(PREFIX + platform, key);
    this.statuses.set(platform, 'unknown');
  }

  async clear(platform: Platform): Promise<void> {
    await this.secrets.delete(PREFIX + platform);
    this.statuses.delete(platform);
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
  async snapshot(): Promise<Array<{ platform: Platform; configured: boolean; keyless: boolean; status: KeyStatus }>> {
    const out: Array<{ platform: Platform; configured: boolean; keyless: boolean; status: KeyStatus }> = [];
    for (const info of allPlatformInfo()) {
      if (info.platform === 'custom') continue;
      const key = await this.get(info.platform);
      const configured = info.keyless || !!key;
      out.push({
        platform: info.platform,
        configured,
        keyless: info.keyless,
        status: this.statuses.get(info.platform) ?? (configured ? 'unknown' : 'missing'),
      });
    }
    return out;
  }

  /** Resolve the key to send for a platform; keyless platforms return ''. */
  async resolveKey(platform: Platform): Promise<string | undefined> {
    const info = getPlatformInfo(platform);
    if (info?.keyless) return '';
    return this.get(platform);
  }
}

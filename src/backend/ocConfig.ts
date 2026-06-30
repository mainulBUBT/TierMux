// Builds the OpenCode config that points OC at the TierMux router proxy.
// Injected via the OPENCODE_CONFIG_CONTENT env var (OC's flag.ts), so no temp
// file is written and the user's global ~/.config/opencode is untouched.
//
// OC sees one custom OpenAI-compatible provider, "tiermux", with three virtual
// models (auto/fast/smart) backed by the router proxy. Failover, rate-limit
// cooldowns, and cost tracking all happen inside the proxy/router — OC just
// thinks it has one reliable provider.

export interface OcConfigOptions {
  /** Router proxy base URL, e.g. http://127.0.0.1:4321/v1 */
  routerProxyBaseURL: string;
  /** Shared secret OC sends as the API key (and that the proxy may validate later). */
  apiKey?: string;
  /** Default agent when none is specified. TierMux uses "build". */
  defaultAgent?: string;
  /** Absolute paths to instruction files appended to every agent's system prompt
   *  (used to rebrand the assistant as TierMux and keep it task-focused). */
  instructionsPaths?: string[];
  /**
   * `tm_<base64url>` encoded IDs of all currently enabled catalog and custom-endpoint
   * models. Added to the static `models` block so OC validates them at session creation.
   * Generated at launch time from settings.enabledByPriority(); models added later
   * require a reload to pick up.
   */
  extraModelIds?: string[];
}

/**
 * Returns a JSON string OC parses as its config. See OC's ProviderConfig schema
 * (config/provider.ts): `npm` selects the SDK adapter, `options.baseURL`/`apiKey`
 * target the proxy, and `models` declares the virtual routing profiles.
 */
export function buildOcConfig(opts: OcConfigOptions): string {
  // Virtual routing profiles — always present so OC's default model (tiermux/auto)
  // is valid and the three "speeds" the UI exposes map to the router's task-kind logic.
  const models: Record<string, object> = {
    auto:  { name: 'Auto',  limit: { context: 128000, output: 8192 } },
    fast:  { name: 'Fast',  limit: { context: 128000, output: 8192 }, attachment: false },
    smart: { name: 'Smart', limit: { context: 200000, output: 8192 } },
  };

  // Every enabled catalog / custom-endpoint model encoded as tm_<base64url> so
  // OC recognises it at createSession + prompt without choking on '::' or '/'.
  for (const id of opts.extraModelIds ?? []) {
    models[id] = { name: id, limit: { context: 128000, output: 8192 } };
  }

  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      tiermux: {
        npm: '@ai-sdk/openai-compatible',
        name: 'TierMux',
        options: {
          baseURL: opts.routerProxyBaseURL,
          apiKey: opts.apiKey ?? 'local',
        },
        models,
      },
    },
    // Force every agent in OC to use the TierMux provider by default, so model
    // selection always flows through the router. Users can still override per-session.
    model: 'tiermux/auto',
    // Append our identity/behavior instructions to every agent's system prompt so the
    // assistant presents as TierMux (not "opencode") and acts on the task directly.
    ...(opts.instructionsPaths?.length ? { instructions: opts.instructionsPaths } : {}),
  };
  return JSON.stringify(cfg);
}

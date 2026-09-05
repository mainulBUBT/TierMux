
/**
 * Local model servers — detection, and the context window actually loaded right now. A custom
 * endpoint has no catalog entry, and LM Studio/Ollama/llama.cpp load a model with a context
 * length chosen at LOAD time (commonly 4096), so a ~6k-token agent prompt into a 4k window came
 * back empty with nothing saying why (cline#6494 is the same bug). None of them put the number
 * in `/v1/models`, hence one server-specific request each:
 *
 *   LM Studio   GET  {origin}/api/v0/models              → loaded_context_length ?? max_context_length
 *   Ollama      POST {origin}/api/show {model}           → model_info["<arch>.context_length"]
 *   llama.cpp   GET  {origin}/props                      → default_generation_settings.n_ctx
 *   KoboldCpp   GET  {origin}/api/v1/config/max_context_length → { value }
 *   vLLM        GET  {origin}/v1/models                  → data[].max_model_len
 *
 * Best-effort: short timeouts, defensive parsing, and only a server that actually answers is
 * believed — nothing is inferred from a port or URL alone.
 */

export type LocalServerKind = 'lmstudio' | 'ollama' | 'llamacpp' | 'koboldcpp' | 'vllm' | 'sglang' | 'tgi' | 'openai-compat';

export interface LocalServerInfo {
  kind: LocalServerKind;
  /** Display label for the UI and for diagnostics. */
  label: string;
  /** Context window actually available for this model, in tokens. Undefined when the server
   *  answered but did not report one. */
  contextWindow?: number;
}

export const LOCAL_SERVER_LABELS: Record<LocalServerKind, string> = {
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  llamacpp: 'llama.cpp',
  koboldcpp: 'KoboldCpp',
  vllm: 'vLLM',
  sglang: 'SGLang',
  tgi: 'Text Generation Inference',
  'openai-compat': 'local OpenAI-compatible server',
};

/** Ports these servers listen on by default. Used only to ORDER the probes (ask the likely server
 *  first), never to decide what a server is — that comes from what actually answers. */
const PORT_HINTS: Record<string, LocalServerKind> = {
  '1234': 'lmstudio',
  '11434': 'ollama',
  '8080': 'llamacpp',   // llama-server, llamafile, LocalAI, mlx-lm all land here
  '8081': 'llamacpp',
  '5001': 'koboldcpp',
  '8000': 'vllm',       // also Lemonade
  '30000': 'sglang',
  '3000': 'tgi',
  '1337': 'llamacpp',   // Jan ships a llama.cpp server
  '39281': 'llamacpp',  // Cortex (Jan's engine)
  '12434': 'openai-compat', // Docker Model Runner
  '4891': 'openai-compat',  // GPT4All
  '5000': 'openai-compat',  // text-generation-webui
  '8090': 'openai-compat',  // Foundry Local / misc
};

/** Ports worth knocking on when hunting for a server the user hasn't configured yet. Ordered by
 *  how likely a developer machine is to be running each one. */
export const KNOWN_LOCAL_PORTS = [
  1234, 11434, 8080, 8000, 1337, 5001, 12434, 30000, 3000, 4891, 5000, 8081, 39281, 8090,
];

/**
 * True when this base URL points at the user's own machine or LAN. Only these are probed: a
 * cloud endpoint would neither answer these paths nor appreciate four extra requests, and
 * probing an arbitrary remote host the user configured is a request they did not ask for.
 */
export function isLocalUrl(baseUrl: string): boolean {
  let host: string;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host === 'host.docker.internal') return true;
  // RFC1918 — a local server reached across the LAN is still a local server.
  if (/^192\.168\./.test(host) || /^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * The server root for a configured base URL. Users paste the OpenAI-compatible path
 * (`http://localhost:1234/v1`), but every native probe below lives at the ORIGIN — so
 * `/v1`, `/api/v0` and a trailing slash all come off.
 */
export function originOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const path = u.pathname.replace(/\/+$/, '')
      .replace(/\/engines\/v\d+$/i, '')       // Docker Model Runner: /engines/v1
      .replace(/\/(v\d+|api\/v\d+|api)$/i, '');
    return `${u.origin}${path}`;
  } catch {
    return baseUrl.replace(/\/+$/, '')
      .replace(/\/engines\/v\d+$/i, '')
      .replace(/\/(v\d+|api\/v\d+|api)$/i, '');
  }
}

type Fetcher = typeof fetch;

async function getJson(url: string, timeoutMs: number, f: Fetcher, init?: RequestInit): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, { ...init, signal: ac.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

const rows = (v: unknown): Array<Record<string, unknown>> => {
  const data = (v as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
};

// ---------------------------------------------------------------------------- per-server probes

/** LM Studio's native REST API. `loaded_context_length` is the window actually allocated in RAM
 *  and is the number that matters; `max_context_length` is only what the architecture could do if
 *  the user reloaded the model, so it is a fallback, not a preference. */
async function probeLmStudio(origin: string, modelId: string, f: Fetcher, timeoutMs: number): Promise<LocalServerInfo | undefined> {
  const data = await getJson(`${origin}/api/v0/models`, timeoutMs, f);
  const list = rows(data);
  if (!list.length) return undefined;
  const entry = list.find((m) => m.id === modelId) ?? list.find((m) => m.state === 'loaded');
  return {
    kind: 'lmstudio',
    label: LOCAL_SERVER_LABELS.lmstudio,
    contextWindow: num(entry?.loaded_context_length) ?? num(entry?.max_context_length),
  };
}

/** Ollama. `/api/ps` describes models currently loaded — its `context_length` is the window in
 *  force for THIS run, which can be far smaller than what the model supports. `/api/show` reports
 *  the architecture's own limit, under a key named for the architecture
 *  (`llama.context_length`, `qwen3.context_length`, …), so the key is matched by suffix. */
async function probeOllama(origin: string, modelId: string, f: Fetcher, timeoutMs: number): Promise<LocalServerInfo | undefined> {
  const ps = await getJson(`${origin}/api/ps`, timeoutMs, f);
  const loaded = Array.isArray((ps as { models?: unknown })?.models)
    ? ((ps as { models: Array<Record<string, unknown>> }).models)
    : undefined;
  if (loaded) {
    // Discovery asks with no model id (nothing is configured yet) — then any running model's
    // window is the answer worth reporting, the same way the LM Studio probe falls back to
    // whatever is loaded.
    const mine = loaded.find((m) => m.model === modelId || m.name === modelId) ?? (modelId ? undefined : loaded[0]);
    const ctx = num(mine?.context_length);
    if (ctx) return { kind: 'ollama', label: LOCAL_SERVER_LABELS.ollama, contextWindow: ctx };
  }

  const show = await getJson(`${origin}/api/show`, timeoutMs, f, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId }),
  });
  if (!show || typeof show !== 'object') return loaded ? { kind: 'ollama', label: LOCAL_SERVER_LABELS.ollama } : undefined;
  const info = (show as { model_info?: Record<string, unknown> }).model_info ?? {};
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length')) {
      const ctx = num(v);
      if (ctx) return { kind: 'ollama', label: LOCAL_SERVER_LABELS.ollama, contextWindow: ctx };
    }
  }
  return { kind: 'ollama', label: LOCAL_SERVER_LABELS.ollama };
}

/** llama.cpp's llama-server (and everything embedding it, e.g. Jan). `n_ctx` is the loaded
 *  window; on a multi-slot server it is the per-slot size, which is the right number for one turn. */
async function probeLlamaCpp(origin: string, _modelId: string, f: Fetcher, timeoutMs: number): Promise<LocalServerInfo | undefined> {
  const props = await getJson(`${origin}/props`, timeoutMs, f) as
    { default_generation_settings?: { n_ctx?: unknown; params?: { n_ctx?: unknown } }; n_ctx?: unknown } | undefined;
  if (!props || typeof props !== 'object') return undefined;
  const gen = props.default_generation_settings;
  const ctx = num(gen?.n_ctx) ?? num(gen?.params?.n_ctx) ?? num(props.n_ctx);
  if (ctx === undefined && gen === undefined) return undefined; // not a llama-server response
  return { kind: 'llamacpp', label: LOCAL_SERVER_LABELS.llamacpp, contextWindow: ctx };
}

/** KoboldCpp's KoboldAI-compatible config endpoint. */
async function probeKobold(origin: string, _modelId: string, f: Fetcher, timeoutMs: number): Promise<LocalServerInfo | undefined> {
  const data = await getJson(`${origin}/api/v1/config/max_context_length`, timeoutMs, f) as { value?: unknown } | undefined;
  const ctx = num(data?.value);
  if (!ctx) return undefined;
  return { kind: 'koboldcpp', label: LOCAL_SERVER_LABELS.koboldcpp, contextWindow: ctx };
}

/** vLLM (and a few other servers) put the real limit on the OpenAI-compatible model object itself.
 *  Runs last: `/v1/models` answers on nearly every server, so a context number here is meaningful
 *  but the absence of one says nothing about which server this is. */
async function probeOpenAiModels(origin: string, modelId: string, f: Fetcher, timeoutMs: number): Promise<LocalServerInfo | undefined> {
  const data = await getJson(`${origin}/v1/models`, timeoutMs, f);
  const list = rows(data);
  if (!list.length) return undefined;
  const entry = list.find((m) => m.id === modelId) ?? list[0];
  const ctx = num(entry?.max_model_len) ?? num(entry?.context_length) ?? num(entry?.max_context_length);
  const kind: LocalServerKind = num(entry?.max_model_len) ? 'vllm' : 'openai-compat';
  return { kind, label: LOCAL_SERVER_LABELS[kind], contextWindow: ctx };
}

/** SGLang. Its context number rides on the OpenAI model object like vLLM's, so the only thing
 *  distinguishing the two is SGLang's own `/get_model_info` — worth asking, because the label is
 *  what tells the user which server to restart. */
async function probeSgLang(origin: string, modelId: string, f: Fetcher, timeoutMs: number): Promise<LocalServerInfo | undefined> {
  const info = await getJson(`${origin}/get_model_info`, timeoutMs, f) as Record<string, unknown> | undefined;
  if (!info || typeof info !== 'object' || !('model_path' in info)) return undefined;
  const models = await getJson(`${origin}/v1/models`, timeoutMs, f);
  const entry = rows(models).find((m) => m.id === modelId) ?? rows(models)[0];
  return {
    kind: 'sglang',
    label: LOCAL_SERVER_LABELS.sglang,
    contextWindow: num(entry?.max_model_len) ?? num(info.context_length) ?? num(info.max_context_length),
  };
}

/** Hugging Face Text Generation Inference. `/info` reports the router's configured limits;
 *  `max_total_tokens` is prompt+output for one request, which is the same thing every other
 *  server here calls the context window. Field names are read defensively — a build that omits
 *  them leaves the window unknown rather than producing a wrong number. */
async function probeTgi(origin: string, _modelId: string, f: Fetcher, timeoutMs: number): Promise<LocalServerInfo | undefined> {
  const info = await getJson(`${origin}/info`, timeoutMs, f) as Record<string, unknown> | undefined;
  if (!info || typeof info !== 'object' || !('model_id' in info)) return undefined;
  return {
    kind: 'tgi',
    label: LOCAL_SERVER_LABELS.tgi,
    contextWindow: num(info.max_total_tokens) ?? num(info.max_input_tokens),
  };
}

type Probe = (origin: string, modelId: string, f: Fetcher, timeoutMs: number) => Promise<LocalServerInfo | undefined>;

const PROBES: Array<[LocalServerKind, Probe]> = [
  ['lmstudio', probeLmStudio],
  ['ollama', probeOllama],
  ['llamacpp', probeLlamaCpp],
  ['koboldcpp', probeKobold],
  ['sglang', probeSgLang],
  ['tgi', probeTgi],
  // Last: `/v1/models` answers on nearly every server, so it can identify but rarely distinguish.
  ['vllm', probeOpenAiModels],
];

/** Probes ordered so the server the port suggests is asked first — a hit on the first request is
 *  the common case, and the rest are then never sent. */
function orderedProbes(origin: string): Array<[LocalServerKind, Probe]> {
  let hint: LocalServerKind | undefined;
  try { hint = PORT_HINTS[new URL(origin).port]; } catch { /* unparseable — keep the default order */ }
  if (!hint) return PROBES;
  return [...PROBES].sort((a, b) => Number(b[0] === hint) - Number(a[0] === hint));
}

// ---------------------------------------------------------------------------- public surface

/** Cache key is origin + model: two models loaded in the same server have different windows. */
const cache = new Map<string, { at: number; info: LocalServerInfo | undefined }>();

/** How long a probe result is trusted. Short on purpose — the user can reload a model with a
 *  different context length at any moment, and a stale large number is exactly the failure this
 *  module exists to prevent. */
const CACHE_TTL_MS = 60_000;

export function invalidateLocalServerCache(): void {
  cache.clear();
}

/**
 * What kind of local server this endpoint is, and how much context it currently has for this
 * model. Returns undefined for a non-local URL or a server that answered nothing.
 *
 * `now` and `fetchImpl` are injectable so the e2e can drive this deterministically without a
 * server or a clock.
 */
export async function probeLocalServer(
  baseUrl: string,
  modelId: string,
  opts: { fetchImpl?: Fetcher; timeoutMs?: number; now?: () => number } = {},
): Promise<LocalServerInfo | undefined> {
  if (!isLocalUrl(baseUrl)) return undefined;
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? Date.now;
  const origin = originOf(baseUrl);
  const key = `${origin}|${modelId}`;

  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.info;

  let info: LocalServerInfo | undefined;
  for (const [, probe] of orderedProbes(origin)) {
    // One failing probe must never stop the others: a server that 404s LM Studio's path may still
    // answer llama.cpp's.
    const got = await probe(origin, modelId, f, timeoutMs).catch(() => undefined);
    if (!got) continue;
    info = got;
    // A server that answered but reported no number is a real identification — keep looking for a
    // window, but remember what it is in case nothing better turns up.
    if (got.contextWindow) break;
  }

  cache.set(key, { at: now(), info });
  return info;
}

/** A local server found listening, ready to be offered as an endpoint. */
export interface DiscoveredServer extends LocalServerInfo {
  /** Origin it answered on, e.g. `http://localhost:1234`. */
  origin: string;
  /** The base URL to configure as a custom endpoint — the OpenAI-compatible path, which is NOT
   *  always `{origin}/v1` (Docker Model Runner serves it under `/engines/v1`). */
  baseUrl: string;
  /** Model ids the server reports, when it lists them. */
  models: string[];
}

/** OpenAI-compatible base path per server kind. Everything except Docker Model Runner (found on
 *  port 12434) serves it at `/v1`. */
function openAiPathFor(origin: string): string {
  let port = '';
  try { port = new URL(origin).port; } catch { /* ignore */ }
  return port === '12434' ? `${origin}/engines/v1` : `${origin}/v1`;
}

/**
 * Knock on the ports local model servers use and report what is actually running, so a user can
 * add one without knowing its URL or which of the OpenAI-compatible paths it uses.
 *
 * Every port is probed concurrently with a short timeout, and a closed port fails instantly
 * (ECONNREFUSED) rather than waiting — so the whole sweep costs about one timeout, not fourteen.
 * Nothing is contacted beyond localhost.
 */
export async function discoverLocalServers(
  opts: { fetchImpl?: Fetcher; timeoutMs?: number; host?: string; ports?: number[] } = {},
): Promise<DiscoveredServer[]> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 800;
  const host = opts.host ?? 'http://localhost';
  const found = await Promise.all((opts.ports ?? KNOWN_LOCAL_PORTS).map(async (port) => {
    const origin = `${host}:${port}`;
    // Identify first, then list models — a server that answers neither is simply not there.
    let info: LocalServerInfo | undefined;
    for (const [, probe] of orderedProbes(origin)) {
      const got = await probe(origin, '', f, timeoutMs).catch(() => undefined);
      if (got) { info = got; break; }
    }
    if (!info) return undefined;
    const listed = await getJson(`${openAiPathFor(origin)}/models`, timeoutMs, f).catch(() => undefined);
    const models = rows(listed).map((m) => String(m.id ?? '')).filter(Boolean);
    return { ...info, origin, baseUrl: openAiPathFor(origin), models } satisfies DiscoveredServer;
  }));
  return found.filter((x): x is DiscoveredServer => !!x);
}

/**
 * The safe input budget for a local server, and the advice to give when it is too small to work
 * with. Pure — the caller supplies the numbers, so this is the piece worth testing.
 *
 * `needed` is what the turn actually wants to send. Below `MIN_WORKABLE_CONTEXT` an agentic turn
 * cannot fit at all: the scaffolding, the skills index and the tool schemas alone exceed it, so
 * the honest answer is to tell the user to reload the model with a bigger window rather than to
 * silently ship a prompt that will be truncated into nonsense.
 */
export const MIN_WORKABLE_CONTEXT = 8192;

export function localContextAdvice(info: LocalServerInfo, needed: number): string | undefined {
  const ctx = info.contextWindow;
  if (!ctx || ctx >= MIN_WORKABLE_CONTEXT) return undefined;
  const how = info.kind === 'lmstudio'
    ? 'In LM Studio, eject the model and load it again with Context Length set to 16384 (enable Flash Attention and Q8 KV cache if memory is tight).'
    : info.kind === 'ollama'
      ? 'In Ollama, raise the window with `/set parameter num_ctx 16384` or set `OLLAMA_CONTEXT_LENGTH=16384` before starting the server.'
      : info.kind === 'llamacpp'
        ? 'Restart llama-server with `-c 16384` (or `--ctx-size 16384`).'
        : info.kind === 'koboldcpp'
          ? 'Restart KoboldCpp with `--contextsize 16384`.'
          : 'Restart the server with a context size of at least 16384.';
  return `${info.label} has only ${ctx.toLocaleString()} tokens of context loaded, but this turn needs about `
    + `${needed.toLocaleString()}. That is why the reply came back empty — the prompt does not fit. ${how}`;
}

/* Does a Zen key actually work from TierMux? The keyed path is a different request from the
 * keyless one (no client costume, `Authorization: Bearer <key>`, the x-opencode-session header),
 * and which base URL accepts it is not something the docs pin down — so probe both, and say plainly
 * which answers.
 *
 *   OPENCODE_KEY=... npm run probe:opencode            # both endpoints
 *   OPENCODE_KEY=... npm run probe:opencode -- <model> # one model, verbose body
 *
 * The key is read from the environment and never printed. */
import { createHash } from 'crypto';

const KEY = (process.env.OPENCODE_KEY ?? '').trim();
const PINNED_MODEL = process.argv[2]?.trim();

/** Same shape as openai-compat's sessionUuid (private there, so rebuilt): a stable UUID derived
 *  from the conversation id, which is what Zen's relay wants on x-opencode-session. */
const SESSION = (() => {
  const hex = createHash('sha1').update('probe-session').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
})();

/** Each surface has its own base AND its own model-discovery URL (Go keeps discovery at
 *  `/inference/go/v1/models`, not under the inference base). Go is the one meant for third-party
 *  agents: it wants an honest UA and `x-opencode-session`, both of which this probe sends. */
const ENDPOINTS = [
  { label: 'Zen — free tier (refuses outside clients)', base: 'https://opencode.ai/zen/v1', models: 'https://opencode.ai/zen/v1/models' },
  { label: 'Console — v2 inference', base: 'https://opencode.ai/inference/openai/v1', models: 'https://opencode.ai/inference/openai/v1/models' },
  { label: 'Go — subscription (opens to other agents)', base: 'https://opencode.ai/inference/go/openai/v1', models: 'https://opencode.ai/inference/go/v1/models' },
] as const;

let bad = 0;
const line = (n: string, ok: boolean, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!ok) bad++; };

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'tiermux/3.0.5',
    'Authorization': `Bearer ${KEY}`,
    'x-opencode-session': SESSION,
  };
}

async function getModels(modelsUrl: string): Promise<{ status: number; ids: string[]; body: string }> {
  const res = await fetch(modelsUrl, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  const body = await res.text();
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(body) as { data?: Array<{ id?: string }> };
    ids = (parsed.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  } catch { /* not JSON — reported as a status-only failure */ }
  return { status: res.status, ids, body };
}

async function oneCompletion(base: string, model: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 16 }),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

function head(s: string, n = 220): string {
  return JSON.stringify(s.replace(/\s+/g, ' ').slice(0, n));
}

async function main(): Promise<void> {
  if (!KEY) {
    console.log('No OPENCODE_KEY in the environment.');
    console.log('A Console key comes from https://opencode.ai/console. Note what it buys: the free-tier');
    console.log('models are served only to OpenCode\'s own client (a key cannot unlock them here); a');
    console.log('Console key gets PAID models, and a Go subscription (https://opencode.ai/go) is the');
    console.log('route OpenCode documents for other coding agents. Then:');
    console.log('  OPENCODE_KEY=... npm run probe:opencode');
    process.exit(2);
  }

  for (const ep of ENDPOINTS) {
    console.log(`\n— ${ep.label}\n  ${ep.base}`);
    let listed: string[] = [];
    try {
      const m = await getModels(ep.models);
      listed = m.ids;
      line('GET /models with this key', m.status === 200 && listed.length > 0,
        m.status === 200 ? `${listed.length} model(s)` : `status=${m.status} ${head(m.body)}`);
    } catch (e) {
      line('GET /models with this key', false, (e as Error).message);
    }

    const model = PINNED_MODEL ?? listed[0] ?? 'glm-5.3-flash';
    if (!model) continue;
    try {
      const c = await oneCompletion(ep.base, model);
      line(`POST /chat/completions (${model})`, c.status === 200, `status=${c.status} ${head(c.body)}`);
    } catch (e) {
      line(`POST /chat/completions (${model})`, false, (e as Error).message);
    }
  }

  console.log(bad === 0
    ? '\nA keyed surface answered. Use that base URL: built-in OpenCode Zen card, or a custom endpoint\npointing at the same URL (TierMux sends x-opencode-session to any opencode.ai host).'
    : '\nHints: 401 "Invalid credential" = wrong key. 401 "Go requires a credential" = the key is fine\nbut this account has no Go subscription. 429 carrying "free usage limit" = the free-tier gate\nrefusing the client (a key cannot fix that). 400 MissingSessionID = the call did not send\nx-opencode-session — TierMux does, so this only happens to hand-rolled requests.');
  process.exit(bad === 0 ? 0 : 1);
}

void main();

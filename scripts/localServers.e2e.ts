/* Local model servers: does TierMux find out how much context they actually have?
 *
 * Why this exists: a custom endpoint has no catalog entry, so inputBudget fell back to its
 * 32768-token default while LM Studio/Ollama/llama.cpp had loaded the model with 4096. TierMux
 * then posted a ~6k-token prompt into a 4k window; the server truncated it or returned nothing,
 * and the turn came back empty in a second with no explanation anywhere. (The same default breaks
 * other agents — cline#6494 is the identical report against LM Studio.)
 *
 * The fixtures below are the REAL response shapes of each server's native endpoint, because the
 * whole value of this module is reading those specific fields correctly. Everything is driven
 * through an injected fetch, so this runs with no server, no network and no clock.
 *
 * Run: npm run test:e2e:local-servers
 */
import {
  probeLocalServer, invalidateLocalServerCache, isLocalUrl, originOf,
  localContextAdvice, MIN_WORKABLE_CONTEXT, discoverLocalServers,
} from '../src/providers/localServers';
import { clampOutputToContext } from '../src/util/thinkTags';
import { inputBudget } from '../src/agent/budget';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `   (${detail})` : ''}`);
};

/** A fetch that answers only the routes given, 404s everything else, and records what was asked. */
function server(routes: Record<string, unknown>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    asked.push(`${init?.method ?? 'GET'} ${u}`);
    const key = Object.keys(routes).find((r) => u.endsWith(r));
    if (!key) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => routes[key] } as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, asked };
}

const probe = (baseUrl: string, modelId: string, routes: Record<string, unknown>) => {
  invalidateLocalServerCache();
  const s = server(routes);
  return probeLocalServer(baseUrl, modelId, { fetchImpl: s.fetch, timeoutMs: 50 }).then((info) => ({ info, asked: s.asked }));
};

async function main(): Promise<void> {
  console.log('— Which URLs are local at all —');
  for (const [url, want] of [
    ['http://localhost:1234/v1', true],
    ['http://127.0.0.1:11434/v1', true],
    ['http://192.168.1.40:8080/v1', true],
    ['http://10.0.0.5:1234/v1', true],
    ['http://172.20.1.9:1234/v1', true],
    ['http://host.docker.internal:1234/v1', true],
    ['http://studio.local:1234/v1', true],
    ['https://api.openai.com/v1', false],
    ['https://openrouter.ai/api/v1', false],
    ['http://172.15.0.1:1234/v1', false],
  ] as Array<[string, boolean]>) {
    check(`${url} → ${want ? 'local' : 'remote'}`, isLocalUrl(url) === want);
  }

  console.log('\n— The OpenAI path comes off; native probes live at the origin —');
  check('/v1 stripped', originOf('http://localhost:1234/v1') === 'http://localhost:1234');
  check('trailing slash stripped', originOf('http://localhost:1234/v1/') === 'http://localhost:1234');
  check('/api/v0 stripped', originOf('http://localhost:1234/api/v0') === 'http://localhost:1234');
  check('bare origin untouched', originOf('http://localhost:11434') === 'http://localhost:11434');
  check('a sub-path is kept', originOf('http://localhost:8080/proxy/v1') === 'http://localhost:8080/proxy');

  console.log('\n— A remote endpoint is never probed —');
  {
    const s = server({ '/api/v0/models': {} });
    const info = await probeLocalServer('https://api.together.xyz/v1', 'x', { fetchImpl: s.fetch });
    check('no probe, no result', info === undefined && s.asked.length === 0, `asked ${s.asked.length}`);
  }

  console.log('\n— LM Studio: loaded_context_length is the number that matters —');
  {
    // Real /api/v0/models shape: max_context_length is what the architecture supports,
    // loaded_context_length is what is actually allocated right now. Reading the wrong one is
    // exactly the bug — a model that COULD do 262144 but was loaded at 4096.
    const { info, asked } = await probe('http://localhost:1234/v1', 'prism-ml/bonsai-27b', {
      '/api/v0/models': {
        data: [
          { id: 'other/model', state: 'not-loaded', max_context_length: 131072 },
          { id: 'prism-ml/bonsai-27b', state: 'loaded', max_context_length: 262144, loaded_context_length: 4096 },
        ],
      },
    });
    check('identified as LM Studio', info?.kind === 'lmstudio', `got ${info?.kind}`);
    check('reports the LOADED window, not the max', info?.contextWindow === 4096, `got ${info?.contextWindow}`);
    check('asked the native endpoint', asked.some((a) => a.includes('/api/v0/models')));
    check('the port hint made it the first probe', asked[0]?.includes('/api/v0/models') === true, asked[0]);
  }
  {
    const { info } = await probe('http://localhost:1234/v1', 'unlisted-model', {
      '/api/v0/models': { data: [{ id: 'something-else', state: 'loaded', max_context_length: 8192 }] },
    });
    check('falls back to the loaded model when the id is unlisted', info?.contextWindow === 8192);
  }

  console.log('\n— Ollama: /api/ps is the live window, /api/show the architecture limit —');
  {
    const { info, asked } = await probe('http://localhost:11434/v1', 'qwen3:8b', {
      '/api/ps': { models: [{ model: 'qwen3:8b', context_length: 8192 }] },
      '/api/show': { model_info: { 'qwen3.context_length': 40960 } },
    });
    check('identified as Ollama', info?.kind === 'ollama', `got ${info?.kind}`);
    check('prefers the running window over the architecture limit', info?.contextWindow === 8192, `got ${info?.contextWindow}`);
    check('did not need /api/show', !asked.some((a) => a.includes('/api/show')));
  }
  {
    const { info } = await probe('http://localhost:11434/v1', 'qwen3:8b', {
      '/api/ps': { models: [] },
      '/api/show': { model_info: { 'qwen3.context_length': 40960, 'qwen3.embedding_length': 4096 } },
    });
    check('falls back to /api/show when nothing is loaded', info?.contextWindow === 40960, `got ${info?.contextWindow}`);
    check('picks context_length, not embedding_length', info?.contextWindow !== 4096);
  }

  console.log('\n— llama.cpp: /props default_generation_settings.n_ctx —');
  {
    const { info } = await probe('http://localhost:8080/v1', 'any', {
      '/props': { default_generation_settings: { id: 0, n_ctx: 16384, params: { n_predict: -1 } } },
    });
    check('identified as llama.cpp', info?.kind === 'llamacpp', `got ${info?.kind}`);
    check('reads n_ctx', info?.contextWindow === 16384, `got ${info?.contextWindow}`);
  }
  {
    // Newer builds nest it under params.
    const { info } = await probe('http://localhost:1337/v1', 'any', {
      '/props': { default_generation_settings: { params: { n_ctx: 32768 } } },
    });
    check('handles the nested params shape (Jan ships llama.cpp)', info?.contextWindow === 32768, `got ${info?.contextWindow}`);
  }

  console.log('\n— KoboldCpp —');
  {
    const { info } = await probe('http://localhost:5001/v1', 'any', {
      '/api/v1/config/max_context_length': { value: 4096 },
    });
    check('identified as KoboldCpp', info?.kind === 'koboldcpp', `got ${info?.kind}`);
    check('reads the configured window', info?.contextWindow === 4096);
  }

  console.log('\n— vLLM: max_model_len on the OpenAI model object —');
  {
    const { info } = await probe('http://localhost:8000/v1', 'meta-llama/Llama-3.1-8B-Instruct', {
      '/v1/models': { data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct', max_model_len: 131072 }] },
    });
    check('identified as vLLM', info?.kind === 'vllm', `got ${info?.kind}`);
    check('reads max_model_len', info?.contextWindow === 131072);
  }

  console.log('\n— SGLang: same max_model_len as vLLM, but a different thing to restart —');
  {
    const { info } = await probe('http://localhost:30000/v1', 'Qwen/Qwen3-8B', {
      '/get_model_info': { model_path: 'Qwen/Qwen3-8B', is_generation: true },
      '/v1/models': { data: [{ id: 'Qwen/Qwen3-8B', max_model_len: 32768 }] },
    });
    check('identified as SGLang, not vLLM', info?.kind === 'sglang', `got ${info?.kind}`);
    check('reads max_model_len', info?.contextWindow === 32768);
  }

  console.log('\n— Text Generation Inference: /info max_total_tokens —');
  {
    const { info } = await probe('http://localhost:3000/v1', 'any', {
      '/info': { model_id: 'meta-llama/Llama-3.1-8B', max_input_tokens: 4095, max_total_tokens: 4096 },
    });
    check('identified as TGI', info?.kind === 'tgi', `got ${info?.kind}`);
    check('prefers max_total_tokens', info?.contextWindow === 4096, `got ${info?.contextWindow}`);
  }
  {
    const { info } = await probe('http://localhost:3000/v1', 'any', { '/info': { model_id: 'x' } });
    check('a build without the fields reports no window, not a wrong one',
      info?.kind === 'tgi' && info?.contextWindow === undefined);
  }

  console.log('\n— Docker Model Runner serves OpenAI under /engines/v1 —');
  check('the engines path is stripped for native probes',
    originOf('http://localhost:12434/engines/v1') === 'http://localhost:12434');
  {
    const { info } = await probe('http://localhost:12434/engines/v1', 'ai/smollm2', {
      '/v1/models': { data: [{ id: 'ai/smollm2' }] },
    });
    check('still identified as a local OpenAI-compatible server', info?.kind === 'openai-compat', `got ${info?.kind}`);
  }

  console.log('\n— A server that answers nothing useful leaves the window unknown —');
  {
    const { info } = await probe('http://localhost:4891/v1', 'gpt4all', { '/v1/models': { data: [{ id: 'gpt4all' }] } });
    check('still identified as an OpenAI-compatible local server', info?.kind === 'openai-compat', `got ${info?.kind}`);
    check('but reports no window rather than guessing one', info?.contextWindow === undefined);
  }
  {
    const { info } = await probe('http://localhost:9999/v1', 'x', {});
    check('a dead port yields nothing at all', info === undefined);
  }

  console.log('\n— Probing is cached: a second turn does not re-interrogate the server —');
  {
    invalidateLocalServerCache();
    const s = server({ '/api/v0/models': { data: [{ id: 'm', state: 'loaded', loaded_context_length: 8192 }] } });
    await probeLocalServer('http://localhost:1234/v1', 'm', { fetchImpl: s.fetch });
    const n = s.asked.length;
    await probeLocalServer('http://localhost:1234/v1', 'm', { fetchImpl: s.fetch });
    check('second probe hits the cache', s.asked.length === n, `${n} → ${s.asked.length}`);
    await probeLocalServer('http://localhost:1234/v1', 'other-model', { fetchImpl: s.fetch });
    check('a different model is probed separately', s.asked.length > n);
  }
  {
    // The user can reload a model with a different context length at any time, so the cache must
    // expire — a stale large number is the exact failure this module exists to prevent.
    invalidateLocalServerCache();
    const s = server({ '/api/v0/models': { data: [{ id: 'm', state: 'loaded', loaded_context_length: 4096 }] } });
    let clock = 1_000_000;
    const opts = { fetchImpl: s.fetch, now: () => clock };
    await probeLocalServer('http://localhost:1234/v1', 'm', opts);
    const n = s.asked.length;
    clock += 61_000;
    await probeLocalServer('http://localhost:1234/v1', 'm', opts);
    check('the cache expires', s.asked.length > n);
  }

  console.log('\n— The budget actually changes: this is the bug being fixed —');
  {
    // 4096-context server, 4096 requested output. Before: contextWindow undefined → 32768 assumed.
    const before = inputBudget(undefined, 4096, 500);
    const after = inputBudget(4096, clampOutputToContext(4096, 4096), 500);
    check('the old default over-promised by ~28k tokens', before > 27000, `${before}`);
    check('the probed window keeps the prompt inside the real context', after < 4096, `${after}`);
    check('output is clamped to a quarter of the window', clampOutputToContext(4096, 4096) === 1024);
    check('a comfortable window leaves the request alone', clampOutputToContext(4096, 131072) === 4096);
    check('an unknown window leaves the request alone', clampOutputToContext(8192, undefined) === 8192);
    check('clamping never goes below a usable floor', clampOutputToContext(4096, 1024) === 512);
  }

  console.log('\n— Discovery: find what is running without being told the URL —');
  {
    invalidateLocalServerCache();
    const s2 = server({
      'localhost:1234/api/v0/models': { data: [{ id: 'qwen3-8b', state: 'loaded', loaded_context_length: 16384 }] },
      'localhost:1234/v1/models': { data: [{ id: 'qwen3-8b' }] },
      'localhost:11434/api/ps': { models: [{ model: 'llama3.2:3b', context_length: 8192 }] },
      'localhost:11434/v1/models': { data: [{ id: 'llama3.2:3b' }] },
    });
    const found = await discoverLocalServers({ fetchImpl: s2.fetch, timeoutMs: 50, ports: [1234, 11434, 8080, 9999] });
    check('found exactly the two that are running', found.length === 2, `found ${found.length}`);
    check('LM Studio identified with its window',
      found.some((x) => x.kind === 'lmstudio' && x.contextWindow === 16384));
    check('Ollama identified with its window',
      found.some((x) => x.kind === 'ollama' && x.contextWindow === 8192));
    check('reports a ready-to-use base URL',
      found.find((x) => x.kind === 'lmstudio')?.baseUrl === 'http://localhost:1234/v1');
    check('lists the models it serves',
      found.find((x) => x.kind === 'ollama')?.models.includes('llama3.2:3b') === true);
    check('a closed port yields nothing', !found.some((x) => x.origin.endsWith('9999')));
  }
  {
    // Docker Model Runner's OpenAI path is not {origin}/v1 — offering the wrong URL would make
    // the endpoint fail on the very first request.
    const s3 = server({
      'localhost:12434/v1/models': { data: [{ id: 'ai/smollm2' }] },
      'localhost:12434/engines/v1/models': { data: [{ id: 'ai/smollm2' }] },
    });
    invalidateLocalServerCache();
    const found = await discoverLocalServers({ fetchImpl: s3.fetch, timeoutMs: 50, ports: [12434] });
    check('Docker Model Runner gets its /engines/v1 base URL',
      found[0]?.baseUrl === 'http://localhost:12434/engines/v1', found[0]?.baseUrl);
  }

  console.log('\n— When it still cannot fit, the user is told what to do —');
  {
    const advice = (kind: string, ctx: number | undefined) =>
      localContextAdvice({ kind: kind as never, label: kind, contextWindow: ctx }, 6000);
    check('a small window produces advice', !!advice('lmstudio', 4096));
    check('…naming the LM Studio control', advice('lmstudio', 4096)?.includes('Context Length') === true);
    check('…naming Ollama\'s num_ctx', advice('ollama', 2048)?.includes('num_ctx') === true);
    check('…naming llama.cpp\'s flag', advice('llamacpp', 2048)?.includes('-c 16384') === true);
    check('…naming KoboldCpp\'s flag', advice('koboldcpp', 2048)?.includes('--contextsize') === true);
    check('…and both numbers', advice('lmstudio', 4096)?.includes('4,096') === true && advice('lmstudio', 4096)?.includes('6,000') === true);
    check('a workable window produces none', advice('lmstudio', MIN_WORKABLE_CONTEXT) === undefined);
    check('an unknown window produces none', advice('lmstudio', undefined) === undefined);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

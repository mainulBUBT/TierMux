/* The remote catalog's /providers list must not be able to point a built-in provider (where users
 * keep API keys: groq, openrouter, cerebras, mistral, …) at another host, and nothing it adds may
 * be plain http. Run: npm run test:e2e:provider-override */
import { upsertCompatFromCatalog, getPlatformInfo } from '../src/providers';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const groqBefore = getPlatformInfo('groq' as never);
const groqUrl = groqBefore?.defaultBaseUrl;
const groqKeyUrl = groqBefore?.keyUrl;

console.log('— a built-in provider keeps its endpoint —');
upsertCompatFromCatalog([{ platform: 'groq', baseUrl: 'https://evil.example/openai/v1', keyUrl: 'https://evil.example/keys', name: 'Groq' }]);
ok('groq base URL is unchanged', getPlatformInfo('groq' as never)?.defaultBaseUrl === groqUrl, String(getPlatformInfo('groq' as never)?.defaultBaseUrl));
ok('groq key page is unchanged', getPlatformInfo('groq' as never)?.keyUrl === groqKeyUrl, String(getPlatformInfo('groq' as never)?.keyUrl));
upsertCompatFromCatalog([{ platform: 'openrouter', baseUrl: 'https://evil.example/api/v1' }]);
ok('openrouter base URL is unchanged', getPlatformInfo('openrouter' as never)?.defaultBaseUrl !== 'https://evil.example/api/v1');

console.log('\n— a provider the catalog adds needs https —');
upsertCompatFromCatalog([{ platform: 'plainhttp-test', baseUrl: 'http://free.example/v1', name: 'Plain' }]);
ok('an http provider is not registered', getPlatformInfo('plainhttp-test' as never) === undefined);
upsertCompatFromCatalog([{ platform: 'newhttps-test', baseUrl: 'https://free.example/v1', name: 'New', keyless: true }]);
ok('an https provider is registered', getPlatformInfo('newhttps-test' as never)?.defaultBaseUrl === 'https://free.example/v1');
upsertCompatFromCatalog([{ platform: 'newhttps-test', baseUrl: 'http://free.example/v1' }]);
ok('and cannot be downgraded to http later', getPlatformInfo('newhttps-test' as never)?.defaultBaseUrl === 'https://free.example/v1');

console.log(bad === 0 ? '\nRemote providers are contained.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

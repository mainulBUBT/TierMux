/* A provider that says its quota is spent is skipped until the reset it names — before the next
 * request 429s — and a 429's retry-after is honored instead of a guessed backoff. A success never
 * clears that window. Run: npm run test:e2e:quota-headers */
import { noteQuotaHeaders, noteRetryAfter, isInCooldown, recordOutcome, quotaCooldownMs } from '../src/router/picker';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };
const H = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
const near = (ms: number | undefined, want: number) => ms !== undefined && Math.abs(ms - want) < 1500;

const now = Date.now();
console.log('— header shapes —');
ok('OpenAI/Groq requests exhausted, reset "2m59.56s"', near(quotaCooldownMs(H({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m59.56s' }), 'groq', now), 179_560));
ok('tokens exhausted, reset "6s"', near(quotaCooldownMs(H({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '6s' }), 'groq', now), 6_000));
ok('IETF ratelimit-remaining 0, reset 30 (seconds)', near(quotaCooldownMs(H({ 'ratelimit-remaining': '0', 'ratelimit-reset': '30' }), 'x', now), 30_000));
ok('OpenRouter x-ratelimit-reset as epoch ms', near(quotaCooldownMs(H({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 45_000) }), 'openrouter', now), 45_000));
ok('kenari plan used up: an hour', near(quotaCooldownMs(H({ 'x-kenari-plan-remaining': '0' }), 'kenari', now), 3_600_000));
ok('quota left: nothing to do', quotaCooldownMs(H({ 'x-ratelimit-remaining-requests': '12', 'x-ratelimit-reset-requests': '1m' }), 'groq', now) === undefined);
ok('no headers: nothing to do', quotaCooldownMs(H({}), 'groq', now) === undefined);
ok('exhausted without a reset: a short default, not forever', near(quotaCooldownMs(H({ 'ratelimit-remaining': '0' }), 'x', now), 60_000));

console.log('\n— the picker skips it, and a success does not clear that —');
noteQuotaHeaders('groq', 'm1', H({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m' }));
ok('a spent model is in cooldown', isInCooldown('groq', 'm1'));
recordOutcome('groq', 'm1', true);
ok('the response that reported it succeeding does not lift it', isInCooldown('groq', 'm1'));
noteRetryAfter('cerebras', 'm2', 20_000);
ok("a 429's retry-after is honored", isInCooldown('cerebras', 'm2'));
ok('an untouched model is free', !isInCooldown('groq', 'other'));

console.log(bad === 0 ? '\nQuota headers hold.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

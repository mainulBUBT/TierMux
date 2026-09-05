/* A declared rate limit of 0 means "unknown", never "unlimited" (2026-08-20 audit: two models
 * with blank sheet cells had no throttling at all and `headroom` reported them fresh, so the
 * router PREFERRED them). `null` still means genuinely unlimited (custom endpoints).
 * Run: npm run test:e2e:rate-limit-zero */
import { RateTracker } from '../src/router/rateTracker';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

console.log('— 0 is treated as unknown, not unlimited —');
{
  const t = new RateTracker();
  // Burn well past any plausible free-tier per-minute allowance.
  for (let i = 0; i < 50; i++) t.record('kenari', 'zero-model');
  ok('a 0/0 model is eventually throttled', !t.canSend('kenari', 'zero-model', 0, 0));
  ok('and its headroom is not reported as fresh', t.headroom('kenari', 'zero-model', 0, 0) < 1);
  ok('and it reports a real cooldown', t.rpmCooldownMs('kenari', 'zero-model', 0) > 0);
}

console.log('\n— null still means genuinely unlimited (custom local endpoints) —');
{
  const t = new RateTracker();
  for (let i = 0; i < 500; i++) t.record('custom', 'local-llama');
  ok('a null/null model is never throttled', t.canSend('custom', 'local-llama', null, null));
  ok('and reports neutral headroom', t.headroom('custom', 'local-llama', null, null) === 1);
  ok('and no cooldown', t.rpmCooldownMs('custom', 'local-llama', null) === 0);
}

console.log('\n— real declared limits are unaffected —');
{
  const t = new RateTracker();
  ok('a fresh model can send', t.canSend('groq', 'gpt-oss-120b', 30, 1000));
  for (let i = 0; i < 30; i++) t.record('groq', 'gpt-oss-120b');
  ok('at the RPM cap it stops', !t.canSend('groq', 'gpt-oss-120b', 30, 1000));
  ok('headroom hits 0 at the cap', t.headroom('groq', 'gpt-oss-120b', 30, 1000) === 0);
  ok('cooldown is under a minute', (() => {
    const ms = t.rpmCooldownMs('groq', 'gpt-oss-120b', 30);
    return ms > 0 && ms <= 60_000;
  })());
  // A 0 on ONE axis must not disable the other axis' real limit.
  const u = new RateTracker();
  for (let i = 0; i < 25; i++) u.record('x', 'mixed');
  ok('rpd=0 does not cancel a real rpm limit', !u.canSend('x', 'mixed', 20, 0));
}

console.log('\n— the shipped catalog no longer contains a zero limit —');
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const catalog = require('../media/catalog.json') as { models: Array<Record<string, unknown>> };
  const zeros = catalog.models.filter((m) => !m.rpmLimit || !m.rpdLimit);
  ok('no model ships with a 0/missing rate limit', zeros.length === 0,
    zeros.map((m) => `${m.platform}/${m.modelId}`).join(', '));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

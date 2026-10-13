/* A session's title is picked once — but a failed pick must not lock in the raw first words of the
 * message ("Just answer deo", "100058 order why minus in distance?" — real sessions, 2026-10-13).
 * The session stays untitled and the next message tries again; only the last attempt falls back.
 * Run: npm run test:e2e:session-title */
import { titleDecision, TITLE_ATTEMPTS, sanitizeTitle } from '../src/session/titles';
import { classifyTask } from '../src/agent/routing';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const msg = 'just answer deo. customer, vendor, riders, deliveryman, providers soho jara jara referral pay';
ok('a generated title is committed', JSON.stringify(titleDecision('Explaining Referral Rewards', 1, msg)) === JSON.stringify({ title: 'Explaining Referral Rewards', retry: false }));
ok('a failed first pick stays untitled and retries', JSON.stringify(titleDecision('', 1, msg)) === JSON.stringify({ retry: true }));
ok(`still retries before attempt ${TITLE_ATTEMPTS}`, titleDecision('', TITLE_ATTEMPTS - 1, msg).retry === true);
const last = titleDecision('', TITLE_ATTEMPTS, msg);
ok('the last attempt falls back to the derived words', last.retry === false && last.title === 'Just answer deo', JSON.stringify(last));
ok('the fallback stops at the first sentence', titleDecision('', TITLE_ATTEMPTS, '100058 order why minus in distance? and why vehicles id not set here?').title === '100058 order why minus in distance');

console.log('\n— what counts as a failed pick —');
ok('model reasoning instead of a title is rejected', sanitizeTitle('The user wants to know about referral rules') === '');
ok('an over-long line is rejected', sanitizeTitle('Fixing the referral reward calculation for every user type in the system today') === '');
ok('a clean title passes through', sanitizeTitle('"Fixing Referral Rewards"') === 'Fixing Referral Rewards');

console.log('\n— small talk earns no title —');
for (const g of ['hola', 'hi', 'assalamualaikum', 'kemon acho']) ok(`"${g}" is small talk`, classifyTask(g) === 'trivial', classifyTask(g));

console.log(bad === 0 ? '\nSession titles hold.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

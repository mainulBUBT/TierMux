/* `/explore`: one read-only explore sub-agent per line, a few at a time, reports in question order.
 * Run: npm run test:e2e:explore-batch */
import { exploreQuestions, runExploreBatch, EXPLORE_MAX_QUESTIONS, EXPLORE_PARALLEL } from '../src/agent/exploreBatch';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d.slice(0, 200)})` : ''}`); if (!c) bad++; };

async function main() {
  console.log('— one question per line —');
  const qs = exploreQuestions('\n  - where is the payment status set?\n2. which job sends the invoice email?\n\n* who calls refund()\n');
  ok('bullets and numbers are stripped, blank lines dropped', JSON.stringify(qs) === JSON.stringify(['where is the payment status set?', 'which job sends the invoice email?', 'who calls refund()']), JSON.stringify(qs));
  ok(`capped at ${EXPLORE_MAX_QUESTIONS}`, exploreQuestions(Array.from({ length: 9 }, (_, i) => `q${i}`).join('\n')).length === EXPLORE_MAX_QUESTIONS);
  ok('nothing to explore is empty', exploreQuestions('   \n ').length === 0);

  console.log('\n— the default runs one at a time; a higher count is honored; order kept; one failure does not sink the rest —');
  let running = 0, peak = 0;
  const explore = async (q: string) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, q === 'q0' ? 40 : 10));
    running--;
    if (q === 'q2') throw new Error('rate limited');
    return `report for ${q}`;
  };
  await runExploreBatch(['a', 'b', 'c'], explore);
  ok(`the default runs ${EXPLORE_PARALLEL} at a time`, EXPLORE_PARALLEL === 1 && peak === 1, `peak=${peak}`);
  peak = 0;
  const out = await runExploreBatch(['q0', 'q1', 'q2', 'q3', 'q4'], explore, 3);
  ok('an explicit count of 3 runs exactly 3 at once', peak === 3, `peak=${peak}`);
  ok('reports keep question order', out.indexOf('### q0') < out.indexOf('### q1') && out.indexOf('### q3') < out.indexOf('### q4'));
  ok('a failed explore says so in its place', /### q2\n\n_Explore failed: rate limited_/.test(out), out);
  ok('the others still report', ['q0', 'q1', 'q3', 'q4'].every((q) => out.includes(`report for ${q}`)));

  console.log(bad === 0 ? '\n/explore batch holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();

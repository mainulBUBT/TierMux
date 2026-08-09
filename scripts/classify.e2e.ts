/* Task classification over REAL user phrasings, including romanized Bengali ("Banglish").
 *
 * Why this exists: classifyTaskCore drives model routing AND which prompt files load, and its
 * regexes were English-only. Running the actual messages from a 2026-08-09 session through it,
 * 6 of 11 came back `confident: false` and fell to the ambiguous `agent` default — handing a
 * plain remark an edit-capable route and paying for an extra LLM classify call each time.
 *
 * Deterministic and offline: no router, no model, no quota.
 *
 * Run: npm run test:e2e:classify
 */
import { classifyTaskCore } from '../src/agent/routing';
import type { TaskKind } from '../src/agent/routing';

let failures = 0;
/** `want` lists every ACCEPTABLE kind — several phrasings are legitimately debatable, and pinning
 *  them to one label would make this test a description of today's regex rather than of intent. */
const expect = (text: string, want: TaskKind[], note = '') => {
  const { kind, confident } = classifyTaskCore(text);
  const pass = want.includes(kind);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${kind.padEnd(11)} conf=${String(confident).padEnd(5)} want=${want.join('|').padEnd(18)} ${text}${note ? `   (${note})` : ''}`);
};

console.log('— Banglish questions (must be read-only, never `agent`) —');
expect('agent manager er kaj ki?', ['chat']);
expect('router ta kivabe kaj kore?', ['chat']);
expect('ei file ta explain koro', ['chat'], 'bare auxiliary must not read as an edit');
expect('ei function ta kothay define kora hoyeche?', ['chat']);
expect('model selection er logic ta kon file e?', ['chat']);
expect('eta keno emon kaj kore?', ['chat']);
expect('task classification kivabe hoy bujhiye dao', ['chat']);

console.log('\n— Banglish actions (must be able to edit) —');
expect('notun ekta component banao', ['agent', 'coding']);
expect('router ta thik koro', ['agent', 'coding', 'debug']);
expect('ei function ta refactor koro', ['coding', 'agent']);
expect('ekta test likho', ['agent', 'coding']);
expect('purono code ta muche dao', ['agent', 'coding']);

console.log('\n— Banglish bug reports (must be debug) —');
expect('login kaj korche na', ['debug']);
expect('button e click korle kichu hocche na', ['debug']);
expect('page ta load hoy na', ['debug']);
expect('data dekhacche na', ['debug']);
expect('ekhane error dicche', ['debug']);

console.log('\n— English must not regress —');
expect('how does the router work?', ['chat']);
expect('what kind of cache is this?', ['chat'], 'TASK_VERB contains "cache"');
expect('what is this project', ['chat']);
expect('fix the failing test', ['debug']);
expect('add a --verbose flag', ['agent', 'coding']);
expect('refactor the user service', ['coding']);
expect('the login page is broken', ['debug']);
expect('hi', ['trivial']);
expect('thanks', ['trivial']);

console.log('\n— Must NOT false-positive on English words containing Banglish stems —');
expect('korean translation library', ['agent', 'chat'], '\\bkor\\b must not match "korean"');
expect('what kind of file is this?', ['chat'], '"kind" must not match \\bki\\b');
expect('the banner needs a new colour', ['agent', 'chat'], '"banner" must not match \\bbanao\\b');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

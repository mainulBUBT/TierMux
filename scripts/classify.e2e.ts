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
import * as fs from 'fs';
import * as path from 'path';
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

/* — Bundled skill bodies —
 *
 * A `/name` invocation does NOT send the user's text: chatViewProvider substitutes the whole
 * SKILL.md body and appends the user's request after it, so the skill body is what
 * classifyTaskCore actually sees. Two ways a well-meaning prompt edit silently mis-routes every
 * invocation of its skill:
 *   - a stray DEBUG_HINT word (`bug`, `broken`, `fails`) anywhere in the body wins over
 *     CODE_HINT, which is tested later — one word in a design skill routed it to `debug`;
 *   - a body over 6000 chars trips the longContext branch before any intent regex runs, pinning
 *     every invocation to a long-context model instead of a coder.
 * Neither is visible when reading the prose, hence this guard.
 */
console.log('\n— Bundled skill bodies (the body IS the classified text) —');
const skillsDir = path.join(__dirname, '..', '.tiermux', 'skills');
const ACTION_KINDS: TaskKind[] = ['agent', 'coding', 'debug'];
/** Kinds each bundled skill must classify as — read-only skills stay read-only, the rest must
 *  keep an edit-capable route. */
const SKILL_WANT: Record<string, TaskKind[]> = {
  design: ['coding', 'agent'],
  landing: ['coding', 'agent'],
  fix: ACTION_KINDS,
  tests: ['agent', 'coding'],
  'code-review': ACTION_KINDS.concat('chat'),
  doc: ['agent', 'coding'],
  explain: ['chat'],
};
for (const file of fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md')).sort()) {
  const name = path.basename(file, '.md');
  const raw = fs.readFileSync(path.join(skillsDir, file), 'utf8');
  const body = /^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/.exec(raw)?.[1]?.trim() ?? raw.trim();
  const want = SKILL_WANT[name];
  if (!want) { console.log(`SKIP  ${name} — no expectation declared`); continue; }
  // Composed the way the provider composes it: body, then the user's request. Checked inline
  // rather than via expect() so the log stays one line per skill instead of echoing every body.
  const { kind, confident } = classifyTaskCore(`${body}\n\nmake the sidebar look better`);
  const okKind = want.includes(kind);
  const okLen = body.length <= 4500;
  if (!okKind || !okLen) failures++;
  const note = okLen ? '' : `   (body ${body.length} chars — over 4500 leaves too little room before the 6000-char longContext trip)`;
  console.log(`${okKind && okLen ? 'PASS' : 'FAIL'}  ${kind.padEnd(11)} conf=${String(confident).padEnd(5)} want=${want.join('|').padEnd(18)} /${name} body (${body.length} chars)${note}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

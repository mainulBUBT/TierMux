/* Skill auto-match: does a plain request activate the right skill WITHOUT a typed `/name`?
 *
 * Why this exists: the full skill body used to be reachable only through `parseSlash`, so the
 * rules applied solely to users who already knew the command existed — "make a landing page" got
 * a one-line index entry and a generic page. `triggers:` frontmatter closes that gap, but an
 * auto-injected 3KB body is only worth it if it fires on the right turns: a false positive spends
 * a free model's whole context window on rules for a job it isn't doing.
 *
 * Precision is therefore what this file tests, in both directions — the misses matter as much as
 * the hits.
 *
 * Deterministic and offline: no router, no model, no quota.
 *
 * Run: npm run test:e2e:skill-match
 */
import * as path from 'path';
import { loadSkills, matchSkill, skillBodyPrompt, skillIndexPrompt } from '../src/context/skills';
import { buildSystemPrompt, setExtensionPath } from '../src/agent/promptBuilder';

let failures = 0;
const extPath = path.join(__dirname, '..');
const skills = loadSkills(extPath);

const expect = (text: string, want: string | undefined, note = '') => {
  const got = matchSkill(text, skills)?.name;
  const pass = got === want;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  got=${String(got ?? '—').padEnd(10)} want=${String(want ?? '—').padEnd(10)} ${text}${note ? `   (${note})` : ''}`);
};

console.log('— Skills loaded —');
for (const sk of skills.values()) {
  console.log(`  /${sk.name.padEnd(12)} triggers=${sk.triggers.length}`);
}

console.log('\n— Landing page requests must activate /landing —');
expect('Make a professional landing page for our this project so user get to know the info', 'landing');
expect('build a marketing page for tiermux', 'landing');
expect('can you make a homepage for the repo', 'landing');
expect('I need a hero section with a call to action', 'landing');
expect('make a website for this project', 'landing', '"website for" trigger');

console.log('\n— UI/styling requests must activate /design —');
expect('restyle the settings panel', 'design');
expect('the sidebar looks ugly, clean it up', 'design');
expect('add dark mode to the webview', 'design');
expect('make it look better please', 'design');
expect('the spacing is inconsistent across the toolbar', 'design');

console.log('\n— Specific beats general: a landing page is not a generic restyle —');
expect('design the landing page for our project', 'landing', 'longest trigger wins over "design the"');

console.log('\n— Must NOT auto-activate anything (no trigger, or wrong domain) —');
expect('why does the router pick a different model each turn?', undefined);
expect('fix the failing test in scoring.e2e.ts', undefined);
expect('add a --verbose flag to the CLI', undefined);
expect('explain how task classification works', undefined);
expect('write unit tests for the metrics store', undefined);
expect('hi', undefined);
expect('', undefined, 'empty input');
expect('the build is broken after the merge', undefined);

console.log('\n— Substring safety: a trigger must match as a whole phrase —');
expect('the cssparser module needs a rewrite', undefined, '"css" must not match inside "cssparser"');
expect('discuss the homepageless routing idea', undefined, '"homepage" must not match inside "homepageless"');

console.log('\n— Already-invoked guard: the /slash path must not inject the body twice —');
{
  const design = skills.get('design');
  if (!design) { failures++; console.log('FAIL  design skill not loaded'); }
  else {
    // Exactly how chatViewProvider composes an explicit `/design` send: body, then user text.
    const slashComposed = `${design.prompt}\n\nmake the sidebar look better`;
    const got = matchSkill(slashComposed, skills)?.name;
    const pass = got === undefined;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  got=${String(got ?? '—').padEnd(10)} want=—          /design body + request must NOT re-match`);
  }
}

console.log('\n— Injection shape —');
{
  const matched = matchSkill('make a landing page for this project', skills);
  const body = matched ? skillBodyPrompt(matched) : '';
  const checks: [string, boolean][] = [
    ['body carries the full skill prompt', !!matched && body.includes(matched.prompt)],
    ['body tells the model the skill APPLIES (not "recommend it")', /APPLY TO THIS TURN/.test(body)],
    ['body resolves the skill dir for relative paths', !!matched && body.includes(matched.dir)],
    ['index still lists the OTHER skills', skillIndexPrompt(extPath, undefined, 'landing').includes('/design')],
    ['index omits the injected skill', !skillIndexPrompt(extPath, undefined, 'landing').includes('`/landing`')],
  ];
  for (const [label, ok] of checks) {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
}

/* The wiring, not just the matcher: matchSkill can be perfect and still never reach the model.
 * buildSystemPrompt is the only path that puts a skill body in front of it. */
async function wiring(): Promise<void> {
  setExtensionPath(extPath);
  const activeIn = async (mode: 'agent' | 'plan' | 'ask', kind: any, text?: string): Promise<string> => {
    const sys = await buildSystemPrompt(mode, kind, undefined, text);
    return /ACTIVE SKILL: `\/([\w-]+)`/.exec(sys)?.[1] ?? '—';
  };
  const check = (label: string, got: string, want: string) => {
    const pass = got === want;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  got=${got.padEnd(10)} want=${want.padEnd(10)} ${label}`);
  };

  const LANDING = 'Make a professional landing page for our this project';
  console.log('\n— buildSystemPrompt injects the matched body (agent mode) —');
  check('agent + landing request', await activeIn('agent', 'agent', LANDING), 'landing');
  check('agent + styling request', await activeIn('agent', 'coding', 'restyle the settings panel'), 'design');
  check('agent + unrelated request', await activeIn('agent', 'coding', 'add a --verbose flag'), '—');

  console.log('\n— Read-only modes must NOT auto-inject (bodies say "make the edits") —');
  check('plan mode', await activeIn('plan', 'plan', LANDING), '—');
  check('ask mode', await activeIn('ask', 'chat', LANDING), '—');

  console.log('\n— Other gates —');
  check('trivial task kind', await activeIn('agent', 'trivial', LANDING), '—');
  check('no userText (back-compat)', await activeIn('agent', 'agent'), '—');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void wiring();

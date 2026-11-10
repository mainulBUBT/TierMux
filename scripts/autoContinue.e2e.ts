/* The host presses Continue itself only within these bounds. Run: npm run test:e2e:auto-continue */
import { shouldAutoContinue, type AutoContinueInput } from '../src/session/autoContinue';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

const base: AutoContinueInput = { mode: 'agent', resumable: true, cancelled: false, changedFiles: 1, completedBefore: 0, completedAfter: 0, used: 0, max: 2 };
const on = (over: Partial<AutoContinueInput>) => shouldAutoContinue({ ...base, ...over });

ok('files changed and work left: continue', on({}));
ok('a todo completed with no file change: continue', on({ changedFiles: 0, completedBefore: 1, completedAfter: 2 }));
ok('a provider stop after progress: continue', on({ stopReason: 'provider' }));
ok('the step limit after progress: continue', on({ stopReason: 'budget' }));
ok('no progress: the button stays', !on({ changedFiles: 0 }));
ok('todos unchanged and no files: the button stays', !on({ changedFiles: 0, completedBefore: 2, completedAfter: 2 }));
ok('a stuck stop never continues', !on({ stopReason: 'stuck' }));
ok('Stop is respected', !on({ cancelled: true }));
ok('a finished turn does nothing', !on({ resumable: false }));
ok('plan mode never continues', !on({ mode: 'plan' }));
ok('ask mode never continues', !on({ mode: 'ask' }));
ok('the round limit holds', !on({ used: 2 }));
ok('0 rounds turns it off', !on({ max: 0 }));

console.log(bad === 0 ? '\nAuto-Continue bounds hold.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

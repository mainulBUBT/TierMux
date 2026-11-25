/* Which mid-turn messages are steered into the running turn and which queue for a turn of their
 * own. The host (chatViewProvider) only feeds the facts in. Run: npm run test:e2e:steer */
import { shouldSteer, steerDecision, type SteerInput } from '../src/session/steer';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const base: SteerInput = { canSteer: true, text: 'also add a test for it', attachments: 0, runningMode: 'agent', sentMode: 'agent' };
const decide = (over: Partial<SteerInput>): string => steerDecision({ ...base, ...over });

ok('a plain message during a running turn is steered', shouldSteer(base), decide({}));
ok('a slash command is a new request — it queues', decide({ text: '/grep TODO' }) === 'slash-command', decide({ text: '/grep TODO' }));
ok('whitespace around a slash command still counts as one', decide({ text: '  /commit  ' }) === 'slash-command', decide({ text: '  /commit  ' }));
ok('an ordinary sentence that merely contains a slash is not a command', shouldSteer({ ...base, text: 'fix the path/to/file issue' }), decide({ text: 'fix the path/to/file issue' }));
ok('a message with attachments queues', decide({ attachments: 1 }) === 'attachments', decide({ attachments: 1 }));
ok('a mode change queues — it has to start its own turn', decide({ sentMode: 'ask' }) === 'mode-change', decide({ sentMode: 'ask' }));
ok('no recorded mode is not read as a change', shouldSteer({ ...base, runningMode: undefined }), decide({ runningMode: undefined }));
ok('no running loop to take it ⇒ queue, exactly as before', decide({ canSteer: false }) === 'no-running-loop', decide({ canSteer: false }));

console.log(bad === 0 ? '\nSteering decision holds.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

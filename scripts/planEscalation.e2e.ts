// Regression test for the plan-mode escalation fix in src/agent/core/loop.ts.
//
// Before the fix, `taskKind` inside runTurn() came only from classifyTask(lastUserText, ...),
// which can never return 'plan' — so a Plan-mode turn was scored against whatever text-derived
// kind classifyTask guessed (chat/agent/coding/...), and the dedicated plan word-floor/quality
// path was unreachable. The fix derives taskKind = 'plan' directly from opts.mode === 'plan'.
//
// Drives the REAL runTurn() -> assessAnswerQuality() -> escalation pipeline with a fake Router,
// across a range of weak/strong first answers and across all 3 AgentModes, to confirm:
//   1. Plan mode escalates on a weak first answer (was previously silently dead).
//   2. Plan mode does NOT escalate on a strong first answer (no wasted second call).
//   3. Agent and Ask modes still escalate on weak answers exactly as before (no regression).
//   4. The escalation call is made with the correct exclude/maxIntelligenceRank options,
//      i.e. it's actually asking the router for a DIFFERENT, stronger model — not a retry
//      of the same weak one.
//
// Run: npm run test:e2e:plan-escalation
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';
import type { AgentOpts, AgentMode } from '../src/agent/agent';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function baseResponse(overrides: Record<string, unknown>) {
  return {
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...overrides } }],
  };
}

// A weak model: refusal, well under the plan word floor (20 words), triggers 'refusal' alone
// (weight 100 >= WEAK_THRESHOLD 40) regardless of task kind's word floor.
const WEAK_ANSWER = "I'm sorry, I cannot help with that.";

// A strong model: long, well-formed, terminated prose — no refusal/repetition/truncation
// signals and comfortably clears every task kind's word floor.
const STRONG_ANSWER = [
  'Here is the plan:',
  '1. Read the existing router configuration to understand the current model catalog.',
  '2. Add a new fallback tier for the low-latency free models under a dedicated key.',
  '3. Update the scoring engine to weigh the new tier during cold start.',
  '4. Write an end-to-end test that exercises the new tier under simulated failure.',
  '5. Document the change in the README so future contributors understand the tier split.',
].join('\n');

interface Call {
  messages: unknown;
  opts: { exclude?: string[]; maxIntelligenceRank?: number };
}

function makeFakeRouter(answers: string[]): { router: Router; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const router = {
    async route(messages: unknown, opts: Call['opts'] = {}) {
      // Plan mode's brainstorm step (loop.ts's runBrainstormStep) makes its own route() call
      // BEFORE the real turn — routerProvider.ts marks it with this trailing instruction.
      // Answer it directly (no genuine fork) without counting it as a turn call: these tests
      // assert exact call counts/indices for the ESCALATION pipeline, which the brainstorm
      // pre-step is not part of.
      if (JSON.stringify(messages).includes('Respond with ONLY valid JSON')) {
        return { platform: 'custom' as const, model: 'brainstorm-model', response: baseResponse({ content: '{"hasFork":false,"approaches":[]}' }) };
      }
      calls.push({ messages, opts });
      const idx = Math.min(n, answers.length - 1);
      const text = answers[n] ?? answers[answers.length - 1];
      n++;
      return {
        platform: 'custom' as const,
        model: idx === 0 ? 'weak-model' : 'strong-model',
        response: baseResponse({ content: text }),
      };
    },
    // A strong executor so the mixture-pipeline planner step (loop.ts's WEAK_EXECUTOR_RANK
    // gate) doesn't fire and consume a route() call — these tests count exact route() calls.
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
  } as unknown as Router;
  return { router, calls };
}

function makeOpts(mode: AgentMode, overrides: Partial<AgentOpts> = {}): AgentOpts {
  return {
    // A confidently-classified verb ("write") so classifyTaskSmart (routing.ts) short-circuits
    // on the regex match with no extra classify-side route() call — this file's fake router
    // returns canned answers by call INDEX, so any incidental extra call shifts every
    // subsequent assertion here (escalation exclude-list, maxIntelligenceRank, call counts).
    messages: [{ role: 'user', content: 'write a plan for adding a new provider tier' }],
    mode,
    effort: 'medium',
    onChunk: () => {},
    onTool: () => {},
    onReasoning: () => {},
    onModel: () => {},
    onFailover: () => {},
    onStep: () => {},
    onTodos: () => {},
    onAskUser: async () => '',
    onError: (m) => console.error('onError:', m),
    ...overrides,
  };
}

async function main() {
  const commandGate = new CommandGate(() => 'always', () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  // --- Range of modes to sweep, weak-vs-strong, model-wise ---
  const MODES: AgentMode[] = ['plan', 'agent', 'ask'];

  for (const mode of MODES) {
    // Weak first answer -> must escalate to a second, different, stronger model.
    {
      const { router, calls } = makeFakeRouter([WEAK_ANSWER, STRONG_ANSWER]);
      const result = await runTurn(router, makeOpts(mode));
      ok(`[${mode}] weak first answer escalates to a second call`, calls.length === 2);
      ok(`[${mode}] escalation excludes the weak model`, !!calls[1]?.opts.exclude?.includes('custom::weak-model'));
      ok(`[${mode}] escalation requests top-tier models (maxIntelligenceRank=2)`, calls[1]?.opts.maxIntelligenceRank === 2);
      ok(`[${mode}] final answer is the escalated (strong) text, not the weak one`, result.text === STRONG_ANSWER);
      ok(`[${mode}] final model reflects the escalated model`, result.model === 'strong-model');
    }

    // Strong first answer -> no escalation, exactly one router call, no wasted second model.
    {
      const { router, calls } = makeFakeRouter([STRONG_ANSWER]);
      const result = await runTurn(router, makeOpts(mode));
      ok(`[${mode}] strong first answer does NOT escalate (single call)`, calls.length === 1);
      ok(`[${mode}] final answer is the first (strong) text`, result.text === STRONG_ANSWER);
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });

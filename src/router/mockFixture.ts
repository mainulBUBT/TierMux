/**
 * Scripted mock model — zero-token development and testing.
 *
 * Two facilities, both routed through env vars so they can never activate for a
 * real user:
 *
 * 1. FIXTURE REPLAY (`TIERMUX_FAKE_MODEL=1`): Router.fakeRoute() asks the
 *    MockPlayer for each response instead of its one canned dummy call. A
 *    fixture is a JSON file of scripted steps, keyed by taskKind queue — the
 *    main turn (`agent`), sub-agents (`coding`, `reasoning`), judges
 *    (`trivial`), and the planner (`plan`) each get their own independent
 *    script, because their calls interleave unpredictably. A step can be a
 *    native tool call, plain text, or RAW DIALECT TEXT (`<function=…>`) — the
 *    last one exercises the rescue/nudge recovery paths against exactly the
 *    weak-model failure shapes the loop exists to defend (record one from a
 *    real session and replay it forever).
 *
 * 2. CASSETTE RECORDING (`TIERMUX_RECORD_CASSETTE=/path.json`): every REAL
 *    successful Router.route() return is appended to the file as a fixture
 *    step. Record a live session once, replay it offline from then on.
 *
 * Fixture format (`.tiermux/mock/fixture.json`):
 * {
 *   "version": 1,
 *   "description": "weak model pastes HTML in chat, recovers on nudge",
 *   "steps": [
 *     { "taskKind": "agent", "tool": "readFile", "args": { "path": "README.md" } },
 *     { "taskKind": "agent", "dialect": "<function=readFile>{\"path\":\"package.json\"}</function>" },
 *     { "taskKind": "agent", "text": "Here is the page:\n```html\n<h1>hi</hi>\n```" },
 *     { "taskKind": "agent", "tool": "createFile", "args": { "path": "out.html", "content": "<h1>hi</h1>" } },
 *     { "taskKind": "agent", "text": "Done." },
 *     { "taskKind": "reasoning", "text": "sub-agent report: found 3 call sites." }
 *   ],
 *   "default": { "text": "[mock] queue exhausted" }
 * }
 *
 * Steps play strictly in order within their taskKind queue (a step with no
 * taskKind joins the `*` queue used for ANY taskKind whose own queue is
 * missing). When every queue is exhausted, `default` answers; when there is no
 * default, fakeRoute's legacy dummy behavior runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { diagLog } from '../util/diag';
import type { ChatMessage, ChatCompletionResponse } from '../shared/types';

/** One scripted response. Exactly one of `text`, `tool`(+`args`)/`tools`, `dialect`. */
export interface MockRespond {
  /** Plain assistant prose — final-answer shape (finish_reason "stop"). */
  text?: string;
  /** A NATIVE tool call (finish_reason "tool_calls"). `args` may be an object or a JSON string. */
  tool?: string;
  args?: unknown;
  tools?: Array<{ name: string; args?: unknown }>;
  /**
   * Raw text that CONTAINS tool-call dialect (e.g. `<function=readFile>{…}</function>`) —
   * emitted as plain content so the rescue parser (rescueInlineToolCalls) and the
   * paste-in-chat nudge paths are exercised exactly as a weak model triggers them.
   */
  dialect?: string;
}

/** A scripted step: which queue it plays in, plus the response (flat, or nested under `respond`). */
export type MockStep = {
  /** Which queue this step belongs to: the route() taskKind ('agent', 'coding', …), or '*' for any. */
  taskKind?: string;
  respond?: MockRespond;
} & Partial<MockRespond>;

export interface MockFixture {
  version: number;
  description?: string;
  steps: MockStep[];
  /** Played when every queue is exhausted. */
  default?: MockRespond;
}

interface QueuedStep { respond: MockRespond; played: boolean; label: string; }

const DEFAULT_FIXTURE_PATHS = () => [
  process.env.TIERMUX_MOCK_FIXTURE,
  path.join(process.cwd(), '.tiermux', 'mock', 'fixture.json'),
].filter((p): p is string => !!p);

function parseFixture(raw: string, source: string): MockFixture | undefined {
  try {
    const parsed = JSON.parse(raw) as MockFixture;
    if (!parsed || !Array.isArray(parsed.steps)) {
      diagLog('router.mock', `fixture ${source} has no steps[] — ignoring`);
      return undefined;
    }
    return parsed;
  } catch (e) {
    diagLog('router.mock', `fixture ${source} failed to parse (${e instanceof Error ? e.message : String(e)}) — ignoring`);
    return undefined;
  }
}

class MockPlayer {
  private readonly queues = new Map<string, QueuedStep[]>();
  private readonly def: MockRespond | undefined;
  private callCount = 0;

  constructor(fixture: MockFixture, readonly source: string) {
    for (const step of fixture.steps) {
      const key = step.taskKind ?? '*';
      const respond: MockRespond = step.respond ?? {
        text: step.text, tool: step.tool, args: step.args, tools: step.tools, dialect: step.dialect,
      };
      const list = this.queues.get(key) ?? [];
      list.push({ respond, played: false, label: labelOf(respond) });
      this.queues.set(key, list);
    }
    this.def = fixture.default;
  }

  /** Next scripted response for this route() call, or undefined when exhausted. */
  next(taskKind?: string): { respond: MockRespond; label: string; exhaustedDefault: boolean } | undefined {
    this.callCount++;
    // Prefer the taskKind's own queue; fall back to the '*' catch-all. Within a queue
    // steps play strictly in order — scripts are movies, not search queries.
    for (const key of [taskKind ?? '*', '*']) {
      const queue = this.queues.get(key);
      if (!queue) continue;
      const step = queue.find((s) => !s.played);
      if (step) {
        step.played = true;
        diagLog('router.mock', `call#${this.callCount} queue=${key} → ${step.label}`);
        return { respond: step.respond, label: step.label, exhaustedDefault: false };
      }
      // An empty-but-present taskKind queue must NOT silently fall through to '*' —
      // a script that names a queue wants it exhausted to mean "done". Only a MISSING
      // queue falls back.
      if (key === (taskKind ?? '*') && queue.length) break;
    }
    if (this.def) {
      diagLog('router.mock', `call#${this.callCount} queues exhausted → default`);
      return { respond: this.def, label: labelOf(this.def), exhaustedDefault: true };
    }
    diagLog('router.mock', `call#${this.callCount} queues exhausted, no default — legacy fake behavior`);
    return undefined;
  }
}

function labelOf(r: MockRespond): string {
  if (r.tool) return `tool:${r.tool}`;
  if (r.tools) return `tools:${r.tools.map((t) => t.name).join('+')}`;
  if (r.dialect) return `dialect:${r.dialect.slice(0, 60)}`;
  return `text:${(r.text ?? '').slice(0, 60)}`;
}

let player: MockPlayer | undefined | null = null; // null = looked, none found

/** Singleton player for the configured fixture, or undefined when there is none. */
export function getMockPlayer(): MockPlayer | undefined {
  if (player !== null) return player ?? undefined;
  for (const p of DEFAULT_FIXTURE_PATHS()) {
    try {
      if (!fs.existsSync(p)) continue;
      const fixture = parseFixture(fs.readFileSync(p, 'utf8'), p);
      if (fixture) {
        player = new MockPlayer(fixture, p);
        diagLog('router.mock', `fixture loaded: ${p} (${fixture.steps.length} steps)`);
        return player;
      }
    } catch { /* unreadable — try the next path */ }
  }
  player = null;
  return undefined;
}

/** Test seam: inject/reset the player without touching env or disk. */
export function setMockPlayerForTest(p: MockPlayer | undefined): void { player = p; }
export function createMockPlayer(fixture: MockFixture, source = '<inline>'): MockPlayer { return new MockPlayer(fixture, source); }

/** Convert a scripted respond into the wire shapes Router.route() returns. */
export function buildMockCompletion(respond: MockRespond): { message: ChatMessage; finish_reason: 'stop' | 'tool_calls' } {
  const calls = [
    ...(respond.tool ? [{ name: respond.tool, args: respond.args }] : []),
    ...(respond.tools ?? []),
  ].map(({ name, args }, i) => ({
    id: `mock_call_${i + 1}`,
    type: 'function' as const,
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
  }));
  if (calls.length) {
    return {
      message: { role: 'assistant', content: null, tool_calls: calls },
      finish_reason: 'tool_calls',
    };
  }
  const text = respond.dialect ?? respond.text ?? '';
  return { message: { role: 'assistant', content: text }, finish_reason: 'stop' };
}

export function buildMockResponse(respond: MockRespond): ChatCompletionResponse {
  const { message, finish_reason } = buildMockCompletion(respond);
  return {
    id: 'mock-completion',
    object: 'chat.completion',
    created: Date.now(),
    model: 'mock-model',
    choices: [{ index: 0, message, finish_reason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Cassette recording ─────────────────────────────────────────────────────────

export interface CassetteRecord {
  taskKind?: string;
  tools?: string[];
  lastRole?: string;
  response: ChatCompletionResponse;
}

class CassetteRecorder {
  private readonly entries: CassetteRecord[] = [];
  constructor(readonly path: string) {}
  record(entry: CassetteRecord): void {
    this.entries.push(entry);
    try {
      fs.writeFileSync(this.path, JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), entries: this.entries }, null, 2));
    } catch (e) {
      diagLog('router.mock', `cassette write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  get size(): number { return this.entries.length; }
}

let recorder: CassetteRecorder | undefined | null = null;

/** Singleton recorder when TIERMUX_RECORD_CASSETTE is set; undefined otherwise. */
export function getCassetteRecorder(): CassetteRecorder | undefined {
  if (recorder !== null) return recorder ?? undefined;
  const p = process.env.TIERMUX_RECORD_CASSETTE;
  recorder = p ? new CassetteRecorder(p) : null;
  return recorder ?? undefined;
}

/** Convert a recorded cassette back into a replayable fixture. */
export function cassetteToFixture(cassettePath: string): MockFixture | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cassettePath, 'utf8')) as { entries?: CassetteRecord[] };
    const steps: MockStep[] = (parsed.entries ?? []).map((e) => {
      const msg = e.response?.choices?.[0]?.message;
      const first = msg?.tool_calls?.[0];
      let respond: MockRespond;
      if (first) {
        let args: unknown;
        try { args = JSON.parse(first.function.arguments || '{}'); } catch { args = first.function.arguments; }
        respond = msg.tool_calls!.length > 1
          ? { tools: msg.tool_calls!.map((tc) => { let a: unknown; try { a = JSON.parse(tc.function.arguments || '{}'); } catch { a = tc.function.arguments; } return { name: tc.function.name, args: a }; }) }
          : { tool: first.function.name, args };
      } else {
        respond = { text: typeof msg?.content === 'string' ? msg.content : '' };
      }
      return { taskKind: e.taskKind, respond };
    });
    return { version: 1, description: `replayed from ${cassettePath}`, steps };
  } catch {
    return undefined;
  }
}

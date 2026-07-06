// Phase 1 spike (plans/recursive-snacking-cupcake.md): confirms live, against a REAL
// running OC engine (not a mocked server like the *.e2e.ts scripts), that a session's
// permission ruleset can be mutated post-creation via PATCH /session/:id and that OC
// re-evaluates it on the NEXT tool call — no session restart needed.
//
// Mirrors sdk.ts's real ordering (subscribe BEFORE prompt, one long-lived connection
// for the whole run — see sdk.ts:573 subscribe / sdk.ts:831 prompt) rather than
// subscribing fresh per turn, to avoid a race where tool events fire before our SSE
// GET has finished connecting.
//
// Requires a TierMux Extension Development Host already running with an active OC
// engine. Find the two env vars from the "TierMux Engine" output channel + the running
// `opencode serve` process's environment:
//   OC_BASE_URL   e.g. http://127.0.0.1:51234   ("OC ready at ..." log line)
//   OC_PASSWORD   `ps aux | grep opencode` for the PID, then
//                 `ps eww <PID> | tr ' ' '\n' | grep OPENCODE_SERVER_PASSWORD`
//
// Run:  OC_BASE_URL=... OC_PASSWORD=... npx esbuild scripts/permissionSpike.manual.ts \
//         --bundle --platform=node --format=cjs --external:vscode \
//         --outfile=dist/permissionSpike.manual.cjs && node dist/permissionSpike.manual.cjs
import { OcClient, type OcEvent } from '../src/backend/ocClient';
import type { OcConnection } from '../src/backend/ocLauncher';

const BASE_URL = process.env.OC_BASE_URL;
const PASSWORD = process.env.OC_PASSWORD;

if (!BASE_URL || !PASSWORD) {
  console.error('Set OC_BASE_URL and OC_PASSWORD env vars — see the header comment in this file.');
  process.exit(1);
}

const conn: OcConnection = { port: 0, baseURL: BASE_URL, password: PASSWORD, process: null as any };
const client = new OcClient(conn);

const DENY = [
  { permission: 'read', pattern: '*', action: 'deny' as const },
  { permission: 'grep', pattern: '*', action: 'deny' as const },
  { permission: 'glob', pattern: '*', action: 'deny' as const },
  { permission: 'list', pattern: '*', action: 'deny' as const },
];
const ALLOW = DENY.map((r) => ({ ...r, action: 'allow' as const }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Connecting to ${BASE_URL} ...`);

  // --- ONE long-lived SSE subscription for the whole spike, established BEFORE any
  // prompt — matches sdk.ts's real ordering. Every raw frame is dumped verbatim so we
  // can see exactly what OC sends, not what we assumed it sends.
  let eventCount = 0;
  let toolRan = false;
  let toolErrored = false;
  let lastText = '';

  const ac = new AbortController();
  const seenToolCallIds = new Set<string>();
  client.subscribe(
    (e: OcEvent) => {
      eventCount++;
      // OC wraps events in a top-level `payload` field — mirrors sdk.ts:579's exact
      // unwrap (confirmed against a live raw dump; the un-unwrapped shape has no `.type`
      // at all, which is what silently broke this script's first version).
      const payload = (e as any).payload ?? e;
      const p = (payload as any).properties ?? {};
      const t = payload.type ?? (e as any).type ?? '';
      console.log(`[event #${eventCount}] type=${t}`);

      // Tool updates arrive as `message.part.updated` with `part.type === 'tool'`
      // NESTED inside — confirmed live; sdk.ts's separate top-level `tool.updated`
      // branch (sdk.ts:709) is an "alternate shape" fallback, not the live path.
      if (t === 'message.part.updated' || t === 'part.updated') {
        const part = p.part ?? (p.type ? p : null);
        if (part && (part.type === 'tool' || part.tool)) {
          const callId = part.id ?? part.partID ?? '';
          const status = part.state?.status ?? part.state;
          if (callId && !seenToolCallIds.has(callId)) {
            seenToolCallIds.add(callId);
            console.log(`  -> NEW tool call id=${callId} tool=${part.tool} status=${status}`);
          } else {
            console.log(`  -> tool update id=${callId} tool=${part.tool} status=${status}`);
          }
          toolRan = true;
          if (status === 'error') toolErrored = true;
        }
        if (part && typeof part.text === 'string') lastText = part.text;
      }
    },
    ac.signal,
    (raw: string) => console.log(`  [raw] ${raw.slice(0, 300)}`),
  );

  console.log('Waiting 1.5s for the SSE connection to establish before sending anything...');
  await sleep(1500);

  const session = await client.createSession({ agent: 'chat', model: { providerID: 'tiermux', id: 'fast' } });
  const sessionId = session.id;
  console.log(`Created session ${sessionId}`);

  const runTurn = async (label: string, question: string) => {
    eventCount = 0; toolRan = false; toolErrored = false; lastText = '';
    console.log(`\n--- ${label}: "${question}" ---`);
    await client.prompt(sessionId, { parts: [{ type: 'text', text: question }], agent: 'chat', model: { providerID: 'tiermux', modelID: 'fast' } });
    await sleep(800); // let trailing SSE frames (session.idle etc.) flush
    console.log(`${label} result: events=${eventCount} toolRan=${toolRan} toolErrored=${toolErrored}`);
    console.log(`${label} answer: ${lastText.slice(0, 300) || '(empty)'}`);
    return { toolRan, toolErrored, text: lastText };
  };

  const r1 = await runTurn('Step 1 (baseline)', 'List the files directly inside your current working directory.');

  console.log('\nPATCH (deny) ...');
  await client.updatePermission(sessionId, DENY);
  const r2 = await runTurn('Step 2 (denied)', 'Read the package.json file and tell me its "name" field.');

  console.log('\nPATCH (allow) ...');
  await client.updatePermission(sessionId, ALLOW);
  const r3 = await runTurn('Step 3 (restored)', 'List the files directly inside your current working directory, once more.');

  console.log('\n=== Summary ===');
  const ok = (name: string, cond: boolean) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  ok('Step 1: a tool ran without error', r1.toolRan && !r1.toolErrored);
  ok('Step 2: deny took effect (tool ran but errored, OR no tool ran)', !r2.toolRan || r2.toolErrored);
  ok('Step 2: model still produced SOME answer text after denial', r2.text.trim().length > 0);
  ok('Step 3: allow restored — a tool ran without error again', r3.toolRan && !r3.toolErrored);

  ac.abort();
  process.exit(0);
}

main().catch((err) => {
  console.error('Spike failed:', err);
  process.exit(1);
});

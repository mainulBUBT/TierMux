// OpenCode HTTP/SSE client — drives the bundled `opencode serve` engine from TierMux's
// sdk.ts seam. Wraps the official `@opencode-ai/sdk` client (pinned to the same version
// as the vendored binary in scripts/fetch-opencode.mjs) instead of hand-rolled fetch/SSE
// parsing, so the request/response shapes and SSE event union track the real server API.
//
// Two fields the SDK's generated OpenAPI types don't declare — `agent`/`model` on
// POST /session and `permission` on PATCH /session/{id} — are real and accepted by the
// live server (verified empirically against the vendored 1.17.11 binary: the server
// echoes them back applied). The generated schema just lags the server here, so those
// two call sites cast the body past the declared type rather than dropping the fields.
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import type { OcConnection } from './ocLauncher';
import type { ChatContent } from '../shared/types';
import { normalizeAttachmentBlocks } from '../agent/content';

/** A user-message part OC understands ({ type: 'text', text }). */
interface TextPart { type: 'text'; text: string }

/** OC's FilePart input (packages/schema/src/v1/session.ts upstream) — a file/image
 *  attachment carried as a `data:` URI. `source` mirrors OC's own FilePartSource union
 *  (unused by TierMux today — toOcParts() never populates it — kept type-compatible so a
 *  future OC upgrade that starts populating it costs nothing here). */
interface FileSource { type: 'file'; path: string }
interface SymbolSource { type: 'symbol'; path: string; name: string }
interface ResourceSource { type: 'resource'; clientName: string; uri: string }
type FilePartSource = FileSource | SymbolSource | ResourceSource;
interface FilePart { type: 'file'; mime: string; filename?: string; url: string; source?: FilePartSource }

interface PromptBody {
  parts: Array<TextPart | FilePart>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
}

/**
 * Build OC's `parts` array from a user message's `ChatContent`, walking the
 * original blocks in order — a text block becomes a `TextPart`, an `image_url`/
 * `file` attachment block becomes a `FilePart`, each at its original position
 * (no regrouping by type: models are sensitive to attachment position, not just
 * presence). Pure mapper: every block produces exactly one part; it never drops
 * or rejects — an oversized attachment is a bug to catch at attach-time
 * (extractAttachments.ts), not something this function silently papers over.
 */
export function toOcParts(content: ChatContent): Array<TextPart | FilePart> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (content == null) return [];
  const parts: Array<TextPart | FilePart> = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push({ type: 'text', text: block });
      continue;
    }
    const b = block as { type?: string; text?: unknown };
    if ((b.type === 'text' || b.type === undefined) && typeof b.text === 'string') {
      if (b.text) parts.push({ type: 'text', text: b.text });
      continue;
    }
    if (b.type === 'image_url' || b.type === 'file') {
      const [attachment] = normalizeAttachmentBlocks([block]);
      if (attachment) parts.push({ type: 'file', mime: attachment.mime, filename: attachment.filename, url: attachment.url });
    }
  }
  console.assert(parts.length > 0 || (Array.isArray(content) && content.length === 0), '[tiermux] toOcParts produced zero parts from non-empty content');
  return parts;
}

interface OcSessionInfo { id: string; [k: string]: unknown }

/** OC's PermissionV1.Rule shape (packages/schema/src/v1/permission.ts). Verified
 *  empirically against the live server: PATCH /session/{id} body `{ permission: rules }`
 *  requires exactly this array-of-rules shape — a flat `{tool: action}` map is rejected. */
export interface OcPermissionRule {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
}

/** OC ServerEvent shape (subset we act on). `properties` is event-specific. */
export interface OcEvent { type: string; properties: any }

export class OcClient {
  private readonly client: OpencodeClient;

  constructor(conn: OcConnection) {
    const auth = `Basic ${Buffer.from(`opencode:${conn.password}`).toString('base64')}`;
    this.client = createOpencodeClient({
      baseUrl: conn.baseURL.replace(/\/$/, ''),
      headers: { Authorization: auth },
      // Preserve the old hand-rolled client's throw-on-!res.ok behavior so every
      // call site here can keep assuming a rejected promise means a non-2xx response.
      throwOnError: true,
    });
  }

  /** List available agents (build, plan, …). Used to pick the plan companion agent id. */
  async listAgents(): Promise<any[]> {
    try {
      const { data } = await this.client.app.agents();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * Create a new session. Optionally pin agent + model up front.
   *
   * NOTE: OC's `POST /session` schema uses `model: { providerID, id }` — a DIFFERENT
   * key (`id`) than the prompt endpoint's `model: { providerID, modelID }`. Sending
   * `modelID` here returns 400 BadRequest and the whole run dies at session creation.
   */
  async createSession(opts?: { agent?: string; model?: { providerID: string; id: string }; title?: string }): Promise<OcSessionInfo> {
    console.log(`[tiermux] OC session.create body=${JSON.stringify(opts ?? {})}`);
    // `agent`/`model` aren't in the SDK's declared SessionCreateData body type (only
    // parentID/title are) but the live server accepts and applies them — see file header.
    const { data } = await this.client.session.create({ body: (opts ?? {}) as any });
    console.log(`[tiermux] OC createSession returned:`, JSON.stringify(data));
    return data as OcSessionInfo;
  }

  /**
   * Send a prompt to a session. OC's POST /message BLOCKS until the whole agent run
   * finishes (results stream separately over the global SSE bus). We do NOT impose a
   * fixed timeout — a run can legitimately take many minutes — and instead let OC drive
   * completion. The optional `signal` (the run's cancel token) aborts it on user-stop.
   */
  async prompt(sessionId: string, body: PromptBody, signal?: AbortSignal): Promise<void> {
    console.log(`[tiermux] OC session.prompt(${sessionId}) body=${JSON.stringify(body)}`);
    try {
      await this.client.session.prompt({
        path: { id: sessionId },
        body: body as any,
        signal,
      });
      console.log(`[tiermux] OC prompt() returned 2xx`);
    } catch (err) {
      console.error(`[tiermux] OC prompt() failed:`, err);
      throw err;
    }
  }

  /**
   * Merge rules into a session's live permission ruleset (PATCH /session/{id}).
   * OC re-evaluates permissions fresh on every tool call (session/tools.ts:
   * `Permission.merge(agent.permission, session.permission)`), so this takes
   * effect on the NEXT tool call — no session restart, no SSE round-trip for
   * an 'allow'/'deny' rule (only 'ask' rules pause and wait for a reply).
   * Callers should treat this as best-effort: catch failures, log, and let the
   * turn continue — this is a backstop on top of prompt-level guidance, not
   * something the turn should depend on to complete.
   */
  async updatePermission(sessionId: string, rules: OcPermissionRule[]): Promise<void> {
    console.log(`[tiermux] OC session.update(${sessionId}) permission=${JSON.stringify(rules)}`);
    // `permission` isn't in the SDK's declared SessionUpdateData body type (only `title`
    // is) but the live server accepts this exact array-of-rules shape — see file header.
    await this.client.session.update({ path: { id: sessionId }, body: { permission: rules } as any });
  }

  /**
   * Reply to a pending `ask` permission request (POST /session/{id}/permissions/{permissionID}).
   * `once` allows just this call, `always` allows this pattern for the rest of the session,
   * `reject` denies it. Verified against the real SDK types (`PostSessionIdPermissionsPermissionIdData`).
   */
  async replyPermission(sessionId: string, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<void> {
    console.log(`[tiermux] OC session.permissions(${sessionId}, ${permissionID}) response=${response}`);
    await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID },
      body: { response },
    });
  }

  /**
   * Fetch the whole session's aggregate file diff (before/after per changed file). Best-effort —
   * used for a read-only "what did this session change" view, not something a run depends on.
   *
   * KNOWN LIMITATION (verified against the vendored 1.17.11 binary): OC's server-side
   * `Session.diff` is currently a hardcoded stub — `function*(q){return[]}` — that always
   * returns an empty array regardless of what actually changed. This isn't a TierMux bug;
   * there's nothing to fix here. `/ocdiff` (chatViewProvider.ts) will start returning real
   * data automatically the moment a future OC version implements this for real — no client
   * changes needed then. Re-verify this comment (grep the binary for `"Session.diff")(function*`)
   * before assuming a future empty result means "no changes" rather than "still unimplemented".
   */
  async diff(sessionId: string): Promise<Array<{ file: string; before: string; after: string; additions: number; deletions: number }>> {
    try {
      const { data } = await this.client.session.diff({ path: { id: sessionId } });
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /** Abort the running prompt for a session. */
  async abort(sessionId: string): Promise<void> {
    try {
      await this.client.session.abort({ path: { id: sessionId } });
    } catch { /* abort is best-effort */ }
  }

  /** Fetch the assembled messages of a session (for persistence/fallback). */
  async messages(sessionId: string): Promise<any[]> {
    try {
      const { data } = await this.client.session.messages({ path: { id: sessionId } });
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * Fork a session, replaying its history into a brand-new session. Verified against
   * OC 1.17.11: forking at a USER message's id returns everything STRICTLY BEFORE it —
   * that message's own turn (and any reply) is excluded. Passing no `messageId` forks
   * the session's current full history as-is.
   */
  async fork(sessionId: string, messageId?: string): Promise<OcSessionInfo> {
    const body = messageId ? { messageID: messageId } : {};
    console.log(`[tiermux] OC session.fork(${sessionId}) body=${JSON.stringify(body)}`);
    const { data } = await this.client.session.fork({ path: { id: sessionId }, body });
    console.log(`[tiermux] OC fork() returned:`, JSON.stringify(data));
    return data as OcSessionInfo;
  }

  /**
   * Subscribe to the global SSE event stream (GET /global/event, matching the webgui's
   * own usage — confirmed against the SDK's `client.global.event()`, which hits the same
   * path). Calls `onEvent` for each streamed event. Returns an unsubscribe that closes
   * the connection. Reconnects on transient errors with the same 1.5s backoff the old
   * hand-rolled reader used (the SDK's own built-in SSE retry targets a different code
   * path — `sse()` helper methods — not the plain `global.event()` method used here).
   *
   * Optional `onRaw` receives the raw event object (JSON-stringified) before dispatch —
   * used by the trace toggle to dump every frame to the TierMux Engine output channel.
   */
  subscribe(onEvent: (e: OcEvent) => void, signal?: AbortSignal, onRaw?: (raw: string) => void): () => void {
    let stopped = false;
    let controller: AbortController | undefined;

    const loop = async () => {
      while (!stopped) {
        controller = new AbortController();
        const onAbort = () => controller?.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          console.log(`[tiermux] OC SSE connecting (global.event)`);
          const result = await this.client.global.event({ signal: controller.signal });
          console.log(`[tiermux] OC SSE connected`);
          // `global.event()` streams `{ directory, payload: Event }` — unwrap to the
          // actual ServerEvent (`{ type, properties }`) callers expect.
          for await (const ev of result.stream) {
            const payload = (ev as { payload?: unknown }).payload ?? ev;
            const raw = JSON.stringify(payload);
            onRaw?.(raw);
            onEvent(payload as OcEvent);
          }
          console.log(`[tiermux] OC SSE stream ended (done)`);
        } catch (err) {
          if (stopped || signal?.aborted) break;
          console.warn(`[tiermux] OC SSE error, reconnecting in 1.5s:`, err instanceof Error ? err.message : err);
          await new Promise((r) => setTimeout(r, 1500));
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      }
    };
    void loop();
    return () => { stopped = true; controller?.abort(); };
  }
}

// One non-streaming completion through the v3 picker, for the utility path (titles, commit
// messages, condense, handoff, inline completions). Failover is the default here: the chain is
// walked, dead keys rotate within a candidate, and an account-level refusal drops the platform
// for the rest of the call. `model` is a PREFERENCE for the head of the chain, never a cage — the
// old Router forced it and threw, so every caller hand-rolled its own retry ladder.
// Deliberately not an AI-SDK LanguageModel: utility callers want one string back.

import type { ChatMessage, Platform, ReasoningEffort } from '../../shared/types';
import { resolveProvider } from '../../providers';
import { recordOutcome, recordRequest } from '../../router/picker';
import { stripThinkTags } from '../../util/thinkTags';
import { diagLog } from '../../util/diag';
import { isFailoverWorthy, resolveCandidates } from './routerProvider';

export interface RouteOnceOptions {
  /** Task kind for the picker's routing table. Defaults to 'work'. */
  taskKind?: string;
  /** Preferred model (`platform::modelId`). Heads the chain; the rest still serve as failover. */
  model?: string;
  /** `platform::modelId` keys to skip — e.g. "the model that just returned an empty summary". */
  exclude?: string[];
  temperature?: number;
  maxTokens?: number;
  effort?: ReasoningEffort;
  abortSignal?: AbortSignal;
  /** Label for diag lines, so a slow utility call is attributable. */
  label?: string;
}

export interface RouteOnceResult {
  /** Assistant text with `<think>` reasoning removed — what every utility caller wants. */
  text: string;
  platform: Platform;
  model: string;
  /** `platform::modelId`, ready to hand back as `exclude` on a retry. */
  key: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Every candidate failed. Carries the walk so "why did nothing answer?" is answerable. */
export class RouteOnceFailedError extends Error {
  constructor(message: string, readonly attempts: string[]) {
    super(message);
    this.name = 'RouteOnceFailedError';
  }
}

/** Account-level refusals condemn the PLATFORM, not just the model: 401/403 mean the key is
 *  bad and 402 means the account cannot pay, so a sibling model on the same platform cannot
 *  possibly succeed. 429 and 5xx are per-model/transient and never condemn. Mirrors the same
 *  rule in routerProvider's chain walk. */
function isAccountLevel(e: unknown): boolean {
  const status = (e as { status?: number } | undefined)?.status;
  return status === 401 || status === 402 || status === 403;
}

/** Test seam — mirrors the engine's `__setEngineModelForTests`. e2e suites that exercise a
 *  CALLER (condense's retry-on-blank, a commit-message prompt) need a scripted answer without
 *  a provider; production never sets this. */
type RouteOnceFn = (messages: ChatMessage[], opts: RouteOnceOptions) => Promise<RouteOnceResult>;
let routeOnceOverride: RouteOnceFn | undefined;
export function __setRouteOnceForTests(fn: RouteOnceFn | undefined): void {
  routeOnceOverride = fn;
}

export async function routeOnce(messages: ChatMessage[], opts: RouteOnceOptions = {}): Promise<RouteOnceResult> {
  if (routeOnceOverride) return routeOnceOverride(messages, opts);
  // `model` is a PREFERENCE (see the header), so it must NOT go in as pinnedModel: selectModel
  // treats a pin as EXACT and returns fallbackChain: [] (PIN = EXACT, 2026-08-31). Every utility
  // caller that passed a preferred model therefore got a single candidate and no failover, which
  // is why condense and the title path hand-rolled a second call without `model` — the exact
  // ladder this module exists to delete. Resolve the normal chain, then hoist the preference.
  const chain = await resolveCandidates({
    taskKind: opts.taskKind ?? 'work',
    excludeModels: opts.exclude,
    effort: opts.effort,
  });
  if (opts.model) {
    const at = chain.findIndex((c) => `${c.platform}::${c.modelId}` === opts.model);
    if (at > 0) chain.unshift(...chain.splice(at, 1));
    else if (at === -1) {
      // Not in the chain at all — an explicitly configured utilityModel that is disabled, in
      // cooldown or keyless-unavailable. A pin resolution honors the user's choice where it can
      // still run; when it cannot, the chain above stands rather than failing the call.
      const pinned = await resolveCandidates({ taskKind: opts.taskKind ?? 'work', pinnedModel: opts.model, effort: opts.effort });
      if (pinned.length > 0) chain.unshift(pinned[0]);
    }
  }
  if (chain.length === 0) {
    throw new RouteOnceFailedError(
      opts.model ? `No usable candidate for ${opts.model}.` : 'No usable model candidate resolved.',
      [],
    );
  }

  const attempts: string[] = [];
  const deadPlatforms = new Set<string>();
  let lastError: unknown;
  for (const c of chain) {
    const key = `${c.platform}::${c.modelId}`;
    if (deadPlatforms.has(c.platform)) {
      attempts.push(`${key} skipped (platform auth/billing already failed)`);
      continue;
    }
    const provider = resolveProvider(c.platform, c.modelId);
    if (!provider) continue;
    // Key rotation within one candidate: a dead or quota'd key must not cost the whole model.
    for (const apiKey of c.apiKeys) {
      try {
        const data = await provider.chatCompletion(apiKey, messages, c.modelId, {
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          reasoningEffort: opts.effort,
          abortSignal: opts.abortSignal,
        });
        recordRequest(c.platform, c.modelId);
        recordOutcome(c.platform, c.modelId, true);
        const raw = data.choices?.[0]?.message?.content;
        const text = stripThinkTags(typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '');
        return {
          text,
          platform: c.platform,
          model: c.modelId,
          key,
          ...(data.usage
            ? { usage: { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } }
            : {}),
        };
      } catch (e) {
        lastError = e;
        recordOutcome(c.platform, c.modelId, false);
        const why = e instanceof Error ? e.message : String(e);
        attempts.push(`${key}: ${why.slice(0, 120)}`);
        if (isAccountLevel(e)) { deadPlatforms.add(c.platform); break; }
        if (!isFailoverWorthy(e)) break; // a schema/logic error repeats on the next key
      }
    }
  }

  diagLog('routeOnce.failed', `${opts.label ?? opts.taskKind ?? 'utility'} — ${attempts.length} attempt(s): ${attempts.join(' | ').slice(0, 400)}`);
  throw new RouteOnceFailedError(
    `Every candidate failed${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
    attempts,
  );
}

/** `routeOnce` that returns undefined instead of throwing — for callers whose feature is
 *  optional (a commit message, an inline completion) and must never surface an error. */
export async function routeOnceOrUndefined(
  messages: ChatMessage[],
  opts: RouteOnceOptions = {},
): Promise<RouteOnceResult | undefined> {
  try {
    return await routeOnce(messages, opts);
  } catch {
    return undefined;
  }
}

/** `tiermux.utilityModel` as a PREFERENCE (undefined when 'auto'/unset/headless). Heads the
 *  chain; the rest is failover — which is what every caller's try/catch used to rebuild. */
export function utilityModelPreference(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode') as typeof import('vscode');
    const v = vscode?.workspace?.getConfiguration?.('tiermux')?.get<string>('utilityModel', 'auto');
    return v && v !== 'auto' ? v : undefined;
  } catch {
    return undefined; // headless (e2e) — the trivial task table is the default anyway
  }
}

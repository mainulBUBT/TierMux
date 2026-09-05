// Routing failure types — thrown by the model layer, rendered by the host.

import type { Platform } from '../shared/types';

export class AllModelsFailedError extends Error {
  /** Why enabled models never became candidates this turn — "All 5 configured models are
   *  unavailable" while a dozen were toggled on (2026-08-25) counted only the pre-filter
   *  survivors. */
  constructor(
    readonly failures: Array<{ platform: Platform; model: string; reason: string; detail?: string }>,
    readonly context?: { total: number; hiddenNoKey: number; hiddenNoTools: number; hiddenUnavailable: number },
  ) {
    super(AllModelsFailedError.describe(failures, context));
    this.name = 'AllModelsFailedError';
  }

  private static describe(
    failures: Array<{ platform: Platform; model: string; reason: string; detail?: string }>,
    context?: { total: number; hiddenNoKey: number; hiddenNoTools: number; hiddenUnavailable: number },
  ): string {
    if (failures.length === 0) {
      return 'No enabled models are configured. Open "Manage Models & Keys" to enable a model and add an API key.';
    }

    if (failures.length === 1) {
      const f = failures[0];
      const who = `${f.platform}/${f.model}`;
      const isCustom = f.platform === 'custom';

      const upstream = f.detail ? ` — endpoint said: ${f.detail}` : '';
      switch (f.reason) {
        case 'no_api_key': return `${who} needs an API key. Add one in "Manage Models & Keys", or set the model to Auto.`;
        case 'no_provider': return `${who} has no provider available. Pick another model, or set it to Auto.`;
        case 'not_found': return `${who} looks deprecated or removed by the provider${isCustom ? ' (or the model ID is wrong for this endpoint)' : ''}. Pick another model, or set it to Auto.${upstream}`;
        case 'rate_limited': return `${who} is rate-limited right now. Try again shortly, or set the model to Auto for automatic failover.`;
        case 'recent_failure': return `${who} failed moments ago and is temporarily benched, so it was not retried this turn. Try again shortly.${upstream}`;
        case 'auth': return isCustom
          ? `${who} rejected the request (HTTP 401/403). Check the endpoint's API key, base URL, and model ID in "Manage Models & Keys".${upstream}`
          : `${who} rejected the API key. Update it in "Manage Models & Keys".${upstream}`;
        case 'bad_request': return `${who} rejected the request (HTTP 400)${isCustom ? ' — often a wrong model ID or unsupported parameter for this endpoint' : ''}.${upstream}`;
        case 'paid_only': return `${who} is paid-only or out of free quota on this provider. Add credit/a key in "Manage Models & Keys", pick a different model, or set it to Auto.`;
        case 'content_filter': return `${who} blocked this request before generating a reply.${upstream} Try a different model, or remove/replace the attachment.`;
        default: return `${who} failed (${f.reason}). Try again, or set the model to Auto.${upstream}`;
      }
    }
    // Multi-failure case: the raw `platform/model (reason)` dump is diagnostic noise to a user who
    // just wants their message to send — nobody reading chat needs to know "poolside/laguna-m.1:free
    // (rate_limited)" verbatim. Summarize by reason category instead; the full per-model detail still
    // reaches the log via each candidate's onProviderAttempt callback, so nothing is lost for debugging.
    const counts = new Map<string, number>();
    for (const f of failures) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
    const label = (reason: string, n: number): string => {
      switch (reason) {
        case 'rate_limited': return `${n} rate-limited`;
        case 'auth': return `${n} with a rejected API key`;
        case 'no_api_key': return `${n} missing an API key`;
        case 'timeout': return `${n} timed out`;
        case 'paid_only': return `${n} paid-only/out of quota`;
        case 'not_found': return `${n} unavailable`;
        // Skipped WITHOUT a request this turn — the model was still inside its circuit-breaker
        // cooldown from a failure moments ago. Distinct from "failed": nothing was dialed.
        case 'recent_failure': return `${n} benched (recently failed)`;
        default: return `${n} failed`;
      }
    };
    const parts = [...counts.entries()].map(([reason, n]) => label(reason, n));
    let msg = `All ${failures.length} configured models are unavailable right now (${parts.join(', ')}). `
      + 'Try again shortly, or check keys/models in "Manage Models & Keys".';
    // Surface the pool this turn could never see, so "All 5 configured" stops reading like
    // "my other enabled models were ignored" — they were filtered before the loop ran.
    if (context) {
      const hidden = context.hiddenNoKey + context.hiddenNoTools + context.hiddenUnavailable;
      if (hidden > 0) {
        const bits: string[] = [];
        if (context.hiddenNoKey > 0) bits.push(`${context.hiddenNoKey} without a usable API key for this turn`);
        if (context.hiddenNoTools > 0) bits.push(`${context.hiddenNoTools} without tool support (Agent mode needs tools)`);
        if (context.hiddenUnavailable > 0) bits.push(`${context.hiddenUnavailable} flagged unavailable by the provider`);
        msg += ` ${hidden} more enabled model${hidden === 1 ? ' was' : 's were'} not tried (${bits.join(', ')}).`;
      }
    }
    return msg;
  }
}

/** A message carries a visual attachment but no vision-capable model exists anywhere in the
 *  catalog (candidates() already widens to the full catalog first). Stopping here beats burning
 *  a request on a text-only model that will refuse. */

export class NoVisionModelError extends Error {
  constructor(reason: 'no_vision_model' | 'no_raw_pdf_provider' = 'no_vision_model') {
    super(
      reason === 'no_raw_pdf_provider'
        // Only Google (Gemini) actually forwards raw PDF bytes today (BaseProvider.carriesRawPdf) —
        // other "vision-capable" providers silently drop the file, so the guidance must point at
        // the one platform that really works rather than a generic vision-model list.
        ? 'This message has a scanned/image-only PDF, but none of your configured models can actually read raw PDF ' +
          'bytes (most providers only support images, not PDF files). Open "Manage Models & Keys" and add a Google ' +
          'AI Studio (Gemini) key to read it.'
        : 'This message has an image or PDF attachment, but none of your configured models can read attachments. ' +
          'Open "Manage Models & Keys" and add a key for a vision-capable model (e.g. Gemini, GPT-4o, Claude) to read it.',
    );
    this.name = 'NoVisionModelError';
  }
}

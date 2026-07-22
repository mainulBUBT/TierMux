

// Profiler instrumentation as AI SDK middleware (wrapLanguageModel), instead of manual
// profiler.timerStart/timerEnd calls scattered through the loop.
import type { LanguageModelV4Middleware } from '@ai-sdk/provider';
import type { IProfilerService, TurnId } from '../../../profiler/types';

export interface TelemetryMiddlewareOptions {
  profiler?: IProfilerService;
  traceId?: TurnId;
  /** Not used today — accepted now so a future logging/tracing convergence point doesn't need
   *  another signature change here. */
  logger?: unknown;
}

export function createTelemetryMiddleware({ profiler, traceId }: TelemetryMiddlewareOptions): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate }) {
      if (!profiler || !traceId) return doGenerate();
      profiler.timerStart(traceId, 'Provider');
      try {
        return await doGenerate();
      } finally {
        profiler.timerEnd(traceId, 'Provider');
      }
    },
    async wrapStream({ doStream }) {
      if (!profiler || !traceId) return doStream();
      profiler.timerStart(traceId, 'Provider');
      try {
        return await doStream();
      } finally {
        profiler.timerEnd(traceId, 'Provider');
      }
    },
  };
}

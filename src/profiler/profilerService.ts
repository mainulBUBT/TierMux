import { NoopProfiler } from './noopProfiler';
import { LiveProfiler } from './liveProfiler';
import type { IProfilerService } from './types';

export type { IProfilerService } from './types';

export function createProfiler(enabled: boolean, ringSize?: number): IProfilerService {
  return enabled ? new LiveProfiler(ringSize) : new NoopProfiler();
}

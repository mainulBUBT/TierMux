import type { IProfilerService, ProfilerExport } from './types';

function getVersion(): string {
  try {
    const pkg = require('../../package.json') as { version: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

export function toExportData(profiler: IProfilerService): ProfilerExport {
  const data = profiler.toExportData();
  return {
    ...data,
    tiermuxVersion: getVersion(),
  };
}

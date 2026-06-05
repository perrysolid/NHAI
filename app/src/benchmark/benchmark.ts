export interface StageTiming {
  name: string;
  ms: number;
}

export interface BenchmarkSummary {
  stages: StageTiming[];
  totalMs: number;
  passedLatencyTarget: boolean;
}

export async function timeStage<T>(
  name: string,
  fn: () => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<{value: T; timing: StageTiming}> {
  const start = now();
  const value = await fn();
  return {value, timing: {name, ms: now() - start}};
}

export function summarizeBenchmark(
  stages: StageTiming[],
  targetMs = 1000,
): BenchmarkSummary {
  const totalMs = stages.reduce((sum, stage) => sum + stage.ms, 0);
  return {stages, totalMs, passedLatencyTarget: totalMs <= targetMs};
}

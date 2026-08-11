import {
  environmentFingerprint,
  type BenchmarkEnvironment,
} from './environment.js';
import type { ScenarioRunResult } from './runner.js';
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkSummary,
  type ScenarioSummary,
} from './schema.js';
import {
  bootstrapQuantileInterval,
  quantile,
  summarizeSamples,
} from './stats.js';

export const PERFORMANCE_BOOTSTRAP_POLICY = Object.freeze({
  confidence: 0.95,
  iterations: 2_000,
  p50Seed: 0x42524952,
  p95Seed: 0x42524953,
});

export function summarizeScenarioRun(result: ScenarioRunResult): ScenarioSummary {
  if (result.samples.length === 0) {
    throw new Error(`Scenario ${result.id} has no measured samples.`);
  }
  const iterations = new Set<number>();
  for (const sample of result.samples) {
    if (sample.scenarioId !== result.id) {
      throw new Error(
        `Scenario ${result.id} contains a sample for ${sample.scenarioId}.`,
      );
    }
    if (iterations.has(sample.iteration)) {
      throw new Error(`Scenario ${result.id} contains duplicate iteration ${sample.iteration}.`);
    }
    iterations.add(sample.iteration);
  }

  const payloads = result.samples
    .map((sample) => sample.payloadBytes)
    .filter((value): value is number => value !== undefined);
  if (payloads.length !== 0 && payloads.length !== result.samples.length) {
    throw new Error(
      `Scenario ${result.id} must record payload bytes for every sample or for none.`,
    );
  }

  const latencySamples = result.samples.map((sample) => sample.durationMs);
  return {
    id: result.id,
    warmups: result.warmups,
    latencyMs: summarizeSamples(latencySamples),
    latencyMsConfidence: {
      method: 'percentile-bootstrap',
      p50: bootstrapQuantileInterval(latencySamples, 0.5, {
        confidence: PERFORMANCE_BOOTSTRAP_POLICY.confidence,
        iterations: PERFORMANCE_BOOTSTRAP_POLICY.iterations,
        seed: PERFORMANCE_BOOTSTRAP_POLICY.p50Seed,
      }),
      p95: bootstrapQuantileInterval(latencySamples, 0.95, {
        confidence: PERFORMANCE_BOOTSTRAP_POLICY.confidence,
        iterations: PERFORMANCE_BOOTSTRAP_POLICY.iterations,
        seed: PERFORMANCE_BOOTSTRAP_POLICY.p95Seed,
      }),
    },
    ...(payloads.length === 0 ? {} : { payloadBytes: quantile(payloads, 0.5) }),
  };
}

export function createBenchmarkSummary(
  runId: string,
  environment: BenchmarkEnvironment,
  results: readonly ScenarioRunResult[],
): BenchmarkSummary {
  if (runId.trim() === '') throw new Error('Benchmark run ID must not be empty.');
  const scenarioIds = new Set<string>();
  const scenarios = results.map((result) => {
    if (scenarioIds.has(result.id)) {
      throw new Error(`Duplicate scenario ID: ${result.id}.`);
    }
    scenarioIds.add(result.id);
    return summarizeScenarioRun(result);
  });
  scenarios.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId,
    environmentFingerprint: environmentFingerprint(environment),
    scenarios,
  };
}

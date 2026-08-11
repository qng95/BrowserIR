export const BENCHMARK_SCHEMA_VERSION = '1.1.0' as const;

export interface SampleSummary {
  count: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  medianAbsoluteDeviation: number;
}

export interface BootstrapInterval {
  estimate: number;
  lower: number;
  upper: number;
  confidence: number;
  iterations: number;
  seed: number;
}

export interface LatencyConfidenceIntervals {
  method: 'percentile-bootstrap';
  p50: BootstrapInterval;
  p95: BootstrapInterval;
}

export interface ScenarioSample {
  scenarioId: string;
  iteration: number;
  durationMs: number;
  payloadBytes?: number;
  metrics?: Readonly<Record<string, number>>;
}

export interface ScenarioSummary {
  id: string;
  warmups: number;
  latencyMs: SampleSummary;
  latencyMsConfidence: LatencyConfidenceIntervals;
  payloadBytes?: number;
}

export interface BenchmarkSummary {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  runId: string;
  environmentFingerprint: string;
  scenarios: ScenarioSummary[];
}

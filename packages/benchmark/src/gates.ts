import type { BenchmarkSummary, ScenarioSummary } from './schema.js';
import type {
  IdentityStabilityMetrics,
  OmissionAccountingMetrics,
  RepresentationQualityMetrics,
} from './metrics.js';

export interface RegressionThresholds {
  maxP50Relative: number;
  maxP50AbsoluteMs: number;
  maxP95Relative: number;
  maxP95AbsoluteMs: number;
  maxPayloadRelative: number;
}

export interface ScenarioComparison {
  id: string;
  p50DeltaMs: number;
  p50Relative: number;
  p95DeltaMs: number;
  p95Relative: number;
  payloadRelative?: number;
}

export interface BenchmarkComparison {
  compatible: boolean;
  passed: boolean;
  failures: string[];
  comparisons: ScenarioComparison[];
}

export interface RepresentationGateMetrics extends RepresentationQualityMetrics {
  identityStability?: IdentityStabilityMetrics;
  omissionAccounting?: OmissionAccountingMetrics;
}

export interface RepresentationReleaseThresholds {
  minEntityPrecision: number;
  minEntityRecall: number;
  minCapabilityPrecision: number;
  minCapabilityRecall: number;
  minRelationPrecision: number;
  minRelationRecall: number;
  minAbstentionPrecision: number;
  minAbstentionRecall: number;
  minIdentityStability: number;
}

export interface RepresentationGateResult {
  passed: boolean;
  failures: string[];
}

const DEFAULT_THRESHOLDS: RegressionThresholds = {
  maxP50Relative: 0.15,
  maxP50AbsoluteMs: 20,
  maxP95Relative: 0.25,
  maxP95AbsoluteMs: 50,
  maxPayloadRelative: 0.05,
};

export const DEFAULT_REPRESENTATION_RELEASE_THRESHOLDS: RepresentationReleaseThresholds = {
  minEntityPrecision: 0.99,
  minEntityRecall: 0.95,
  minCapabilityPrecision: 1,
  minCapabilityRecall: 0.95,
  minRelationPrecision: 1,
  minRelationRecall: 0.95,
  minAbstentionPrecision: 1,
  minAbstentionRecall: 1,
  minIdentityStability: 1,
};

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

const requireMinimum = (
  failures: string[],
  label: string,
  actual: number,
  minimum: number,
): void => {
  if (actual < minimum) {
    failures.push(`${label} ${percent(actual)} is below ${percent(minimum)}.`);
  }
};

/**
 * Apply the public 0.1 representation policy to one aggregate ground-truth run.
 * Empty fact classes are rejected so perfect zero-denominator ratios cannot make
 * an unexercised capability appear release-qualified.
 */
export function evaluateRepresentationReleaseGate(
  metrics: RepresentationGateMetrics,
  thresholds: RepresentationReleaseThresholds = DEFAULT_REPRESENTATION_RELEASE_THRESHOLDS,
): RepresentationGateResult {
  const failures: string[] = [];
  const nonEmpty: readonly [string, number][] = [
    ['Entity ground truth', metrics.entities.expected],
    ['Capability ground truth', metrics.capabilities.expected],
    ['Relation ground truth', metrics.relations.expected],
    ['Abstention ground truth', metrics.correctAbstention.expected],
  ];
  for (const [label, expected] of nonEmpty) {
    if (expected === 0) failures.push(`${label} is empty.`);
  }

  requireMinimum(
    failures,
    'Entity precision',
    metrics.entities.precision,
    thresholds.minEntityPrecision,
  );
  requireMinimum(
    failures,
    'Entity recall',
    metrics.entities.recall,
    thresholds.minEntityRecall,
  );
  requireMinimum(
    failures,
    'Capability precision',
    metrics.capabilities.precision,
    thresholds.minCapabilityPrecision,
  );
  requireMinimum(
    failures,
    'Capability recall',
    metrics.capabilities.recall,
    thresholds.minCapabilityRecall,
  );
  requireMinimum(
    failures,
    'Relation precision',
    metrics.relations.precision,
    thresholds.minRelationPrecision,
  );
  requireMinimum(
    failures,
    'Relation recall',
    metrics.relations.recall,
    thresholds.minRelationRecall,
  );
  requireMinimum(
    failures,
    'Abstention precision',
    metrics.correctAbstention.precision,
    thresholds.minAbstentionPrecision,
  );
  requireMinimum(
    failures,
    'Abstention recall',
    metrics.correctAbstention.recall,
    thresholds.minAbstentionRecall,
  );

  if (metrics.identityStability === undefined) {
    failures.push('Identity-stability evidence is missing.');
  } else if (metrics.identityStability.baseline === 0) {
    failures.push('Identity-stability evidence has no baseline identities.');
  } else {
    requireMinimum(
      failures,
      'Identity stability',
      metrics.identityStability.rate,
      thresholds.minIdentityStability,
    );
  }

  if (metrics.omissionAccounting === undefined) {
    failures.push('Omission-accounting evidence is missing.');
  } else if (!metrics.omissionAccounting.exact) {
    failures.push(
      `Omission accounting is not exact (${metrics.omissionAccounting.unreported} unreported, ${metrics.omissionAccounting.overreported} over-reported).`,
    );
  }

  return { passed: failures.length === 0, failures };
}

const relativeChange = (baseline: number, candidate: number): number => {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (candidate - baseline) / baseline;
};

const byId = (summary: BenchmarkSummary): Map<string, ScenarioSummary> =>
  new Map(summary.scenarios.map((scenario) => [scenario.id, scenario]));

export function compareBenchmarkRuns(
  baseline: BenchmarkSummary,
  candidate: BenchmarkSummary,
  thresholds: RegressionThresholds = DEFAULT_THRESHOLDS,
): BenchmarkComparison {
  if (baseline.schemaVersion !== candidate.schemaVersion) {
    return {
      compatible: false,
      passed: false,
      failures: [
        `Benchmark schema mismatch: ${baseline.schemaVersion} versus ${candidate.schemaVersion}.`,
      ],
      comparisons: [],
    };
  }
  if (baseline.environmentFingerprint !== candidate.environmentFingerprint) {
    return {
      compatible: false,
      passed: false,
      failures: ['Benchmark environment fingerprints do not match.'],
      comparisons: [],
    };
  }

  const failures: string[] = [];
  const comparisons: ScenarioComparison[] = [];
  const candidateScenarios = byId(candidate);
  for (const reference of baseline.scenarios) {
    const current = candidateScenarios.get(reference.id);
    if (current === undefined) {
      failures.push(`Scenario ${reference.id} is missing from the candidate run.`);
      continue;
    }
    const p50DeltaMs = current.latencyMs.p50 - reference.latencyMs.p50;
    const p95DeltaMs = current.latencyMs.p95 - reference.latencyMs.p95;
    const p50Relative = relativeChange(
      reference.latencyMs.p50,
      current.latencyMs.p50,
    );
    const p95Relative = relativeChange(
      reference.latencyMs.p95,
      current.latencyMs.p95,
    );
    const payloadRelative =
      reference.payloadBytes === undefined || current.payloadBytes === undefined
        ? undefined
        : relativeChange(reference.payloadBytes, current.payloadBytes);
    comparisons.push({
      id: reference.id,
      p50DeltaMs,
      p50Relative,
      p95DeltaMs,
      p95Relative,
      ...(payloadRelative === undefined ? {} : { payloadRelative }),
    });

    if (
      p50DeltaMs > thresholds.maxP50AbsoluteMs &&
      p50Relative > thresholds.maxP50Relative
    ) {
      failures.push(
        `${reference.id} p50 regressed by ${p50DeltaMs.toFixed(2)} ms (${(
          p50Relative * 100
        ).toFixed(2)}%).`,
      );
    }
    if (
      p95DeltaMs > thresholds.maxP95AbsoluteMs &&
      p95Relative > thresholds.maxP95Relative
    ) {
      failures.push(
        `${reference.id} p95 regressed by ${p95DeltaMs.toFixed(2)} ms (${(
          p95Relative * 100
        ).toFixed(2)}%).`,
      );
    }
    if (
      payloadRelative !== undefined &&
      payloadRelative > thresholds.maxPayloadRelative
    ) {
      failures.push(
        `${reference.id} payload grew by ${(payloadRelative * 100).toFixed(2)}%.`,
      );
    }
  }

  return {
    compatible: true,
    passed: failures.length === 0,
    failures,
    comparisons,
  };
}

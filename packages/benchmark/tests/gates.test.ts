import { describe, expect, it } from 'vitest';

import {
  compareBenchmarkRuns,
  evaluateRepresentationReleaseGate,
} from '../src/gates.js';
import type { RepresentationGateMetrics } from '../src/gates.js';
import type { BenchmarkSummary } from '../src/schema.js';

const summary = (
  fingerprint: string,
  values: { p50: number; p95: number; payloadBytes: number },
): BenchmarkSummary => ({
  schemaVersion: '1.1.0',
  runId: `run-${fingerprint}`,
  environmentFingerprint: fingerprint,
  scenarios: [
    {
      id: 'observe/200-controls',
      warmups: 5,
      latencyMs: {
        count: 100,
        min: values.p50,
        max: values.p95,
        p50: values.p50,
        p95: values.p95,
        medianAbsoluteDeviation: 1,
      },
      latencyMsConfidence: {
        method: 'percentile-bootstrap',
        p50: {
          estimate: values.p50,
          lower: values.p50,
          upper: values.p50,
          confidence: 0.95,
          iterations: 2_000,
          seed: 0x42524952,
        },
        p95: {
          estimate: values.p95,
          lower: values.p95,
          upper: values.p95,
          confidence: 0.95,
          iterations: 2_000,
          seed: 0x42524953,
        },
      },
      payloadBytes: values.payloadBytes,
    },
  ],
});

describe('benchmark regression gates', () => {
  it('refuses to compare different environment fingerprints', () => {
    const result = compareBenchmarkRuns(
      summary('a', { p50: 100, p95: 150, payloadBytes: 1_000 }),
      summary('b', { p50: 100, p95: 150, payloadBytes: 1_000 }),
    );
    expect(result.compatible).toBe(false);
    expect(result.failures[0]).toMatch(/environment/i);
  });

  it('applies relative and absolute latency thresholds plus payload growth', () => {
    const baseline = summary('same', {
      p50: 100,
      p95: 200,
      payloadBytes: 1_000,
    });
    const candidate = summary('same', {
      p50: 130,
      p95: 280,
      payloadBytes: 1_100,
    });
    const result = compareBenchmarkRuns(baseline, candidate, {
      maxP50Relative: 0.15,
      maxP50AbsoluteMs: 20,
      maxP95Relative: 0.25,
      maxP95AbsoluteMs: 50,
      maxPayloadRelative: 0.05,
    });

    expect(result.compatible).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      expect.stringMatching(/p50/i),
      expect.stringMatching(/p95/i),
      expect.stringMatching(/payload/i),
    ]);
  });

  it('passes changes within the configured budgets', () => {
    const baseline = summary('same', {
      p50: 100,
      p95: 200,
      payloadBytes: 1_000,
    });
    const candidate = summary('same', {
      p50: 110,
      p95: 220,
      payloadBytes: 1_040,
    });
    expect(compareBenchmarkRuns(baseline, candidate)).toMatchObject({
      compatible: true,
      passed: true,
      failures: [],
    });
  });
});

const passingRepresentation = (): RepresentationGateMetrics => ({
  entities: {
    expected: 100,
    observed: 100,
    truePositive: 100,
    falsePositive: 0,
    falseNegative: 0,
    precision: 1,
    recall: 1,
    f1: 1,
  },
  capabilities: {
    expected: 20,
    observed: 20,
    truePositive: 20,
    falsePositive: 0,
    falseNegative: 0,
    precision: 1,
    recall: 1,
    f1: 1,
  },
  relations: {
    expected: 10,
    observed: 10,
    truePositive: 10,
    falsePositive: 0,
    falseNegative: 0,
    precision: 1,
    recall: 1,
    f1: 1,
  },
  correctAbstention: {
    expected: 4,
    observed: 4,
    correct: 4,
    unexpected: 0,
    missed: 0,
    precision: 1,
    recall: 1,
    f1: 1,
    rate: 1,
  },
  identityStability: {
    baseline: 8,
    observed: 8,
    comparable: 8,
    stable: 8,
    changed: 0,
    missing: 0,
    added: 0,
    rate: 1,
  },
  omissionAccounting: {
    known: 3,
    reported: 3,
    accounted: 3,
    unreported: 0,
    overreported: 0,
    precision: 1,
    recall: 1,
    f1: 1,
    exact: true,
    categories: [],
  },
});

describe('representation release gate', () => {
  it('passes a non-vacuous aggregate at every declared threshold', () => {
    expect(evaluateRepresentationReleaseGate(passingRepresentation())).toEqual({
      passed: true,
      failures: [],
    });
  });

  it('fails unsafe false positives and below-threshold recall', () => {
    const metrics = passingRepresentation();
    metrics.entities.precision = 0.989;
    metrics.capabilities.falsePositive = 1;
    metrics.capabilities.precision = 0.95;
    metrics.relations.recall = 0.94;
    metrics.correctAbstention.missed = 1;
    metrics.correctAbstention.recall = 0.75;
    metrics.correctAbstention.rate = 0.75;
    metrics.identityStability!.changed = 1;
    metrics.identityStability!.stable = 7;
    metrics.identityStability!.rate = 0.875;
    metrics.omissionAccounting!.exact = false;
    metrics.omissionAccounting!.unreported = 1;

    const result = evaluateRepresentationReleaseGate(metrics);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      expect.stringMatching(/entity precision/i),
      expect.stringMatching(/capability precision/i),
      expect.stringMatching(/relation recall/i),
      expect.stringMatching(/abstention recall/i),
      expect.stringMatching(/identity stability/i),
      expect.stringMatching(/omission accounting/i),
    ]);
  });

  it('rejects missing or vacuous release-critical evidence', () => {
    const metrics = passingRepresentation();
    metrics.relations.expected = 0;
    metrics.correctAbstention.expected = 0;
    delete metrics.identityStability;
    delete metrics.omissionAccounting;

    const result = evaluateRepresentationReleaseGate(metrics);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      expect.stringMatching(/relation ground truth/i),
      expect.stringMatching(/abstention ground truth/i),
      expect.stringMatching(/identity-stability evidence/i),
      expect.stringMatching(/omission-accounting evidence/i),
    ]);
  });
});

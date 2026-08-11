import { describe, expect, it } from 'vitest';

import { createBenchmarkSummary, summarizeScenarioRun } from '../src/summary.js';

describe('benchmark run summaries', () => {
  it('uses type-7 latency summaries and the median measured payload', () => {
    const summary = summarizeScenarioRun({
      id: 'observe/orders',
      warmups: 5,
      samples: [
        { scenarioId: 'observe/orders', iteration: 0, durationMs: 10, payloadBytes: 100 },
        { scenarioId: 'observe/orders', iteration: 1, durationMs: 20, payloadBytes: 300 },
        { scenarioId: 'observe/orders', iteration: 2, durationMs: 30, payloadBytes: 200 },
      ],
    });

    expect(summary.latencyMs).toMatchObject({ count: 3, p50: 20, p95: 29 });
    expect(summary.warmups).toBe(5);
    expect(summary.latencyMsConfidence).toMatchObject({
      method: 'percentile-bootstrap',
      p50: { estimate: 20, confidence: 0.95, iterations: 2_000 },
      p95: { estimate: 29, confidence: 0.95, iterations: 2_000 },
    });
    expect(summary.latencyMsConfidence.p50.lower).toBeLessThanOrEqual(20);
    expect(summary.latencyMsConfidence.p50.upper).toBeGreaterThanOrEqual(20);
    expect(summary.latencyMsConfidence.p95.lower).toBeLessThanOrEqual(29);
    expect(summary.latencyMsConfidence.p95.upper).toBeGreaterThanOrEqual(29);
    expect(summary.payloadBytes).toBe(200);
  });

  it('rejects partial payload instrumentation instead of comparing unlike samples', () => {
    expect(() =>
      summarizeScenarioRun({
        id: 'partial',
        warmups: 0,
        samples: [
          { scenarioId: 'partial', iteration: 0, durationMs: 1, payloadBytes: 10 },
          { scenarioId: 'partial', iteration: 1, durationMs: 2 },
        ],
      }),
    ).toThrow(/payload.*every sample/i);
  });

  it('sorts scenarios, fingerprints the environment, and rejects duplicate IDs', () => {
    const environment = {
      os: { platform: 'linux', release: 'x', arch: 'x64' },
      runtime: { node: '22', pnpm: '10' },
      browser: { playwright: '1', chromium: '2', headless: true },
      profile: { viewport: '1440x900', deviceScaleFactor: 1 },
    } as const;
    const scenario = (id: string) => ({
      id,
      warmups: 0,
      samples: [{ scenarioId: id, iteration: 0, durationMs: 1 }],
    });

    const summary = createBenchmarkSummary('run-1', environment, [scenario('z'), scenario('a')]);
    expect(summary.scenarios.map((item) => item.id)).toEqual(['a', 'z']);
    expect(summary.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createBenchmarkSummary('run-2', environment, [scenario('a'), scenario('a')])).toThrow(
      /duplicate scenario/i,
    );
  });
});

import { describe, expect, it } from 'vitest';

import {
  renderBenchmarkJson,
  renderBenchmarkMarkdown,
  renderSamplesNdjson,
} from '../src/performance-report.js';

const summary = {
  schemaVersion: '1.1.0' as const,
  runId: 'run<&',
  environmentFingerprint: 'abc',
  scenarios: [
    {
      id: 'observe-warm/orders',
      warmups: 5,
      latencyMs: {
        count: 2,
        min: 10,
        max: 30,
        p50: 20,
        p95: 29,
        medianAbsoluteDeviation: 10,
      },
      latencyMsConfidence: {
        method: 'percentile-bootstrap' as const,
        p50: {
          estimate: 20,
          lower: 10,
          upper: 30,
          confidence: 0.95,
          iterations: 2_000,
          seed: 1_112_689_234,
        },
        p95: {
          estimate: 29,
          lower: 20,
          upper: 30,
          confidence: 0.95,
          iterations: 2_000,
          seed: 1_112_689_235,
        },
      },
      payloadBytes: 1200,
    },
  ],
};

describe('performance benchmark reports', () => {
  it('renders deterministic JSON and readable Markdown', () => {
    expect(renderBenchmarkJson(summary)).toBe(`${JSON.stringify(summary, null, 2)}\n`);
    const markdown = renderBenchmarkMarkdown(summary);
    expect(markdown).toContain(
      '| observe-warm/orders | 5 | 2 | 20.00 | 10.00–30.00 | 29.00 | 20.00–30.00 | 10.00 | 1,200 |',
    );
    expect(markdown).toContain('95% seeded percentile-bootstrap intervals');
    expect(markdown).toContain('run<&');
    expect(markdown).toContain(
      'navigate and settle once per isolated target, then time only steady-state observe calls',
    );
  });

  it('renders every raw sample as one canonical NDJSON record', () => {
    const output = renderSamplesNdjson([
      {
        id: 'observe-warm/orders',
        warmups: 5,
        samples: [
          { scenarioId: 'observe-warm/orders', iteration: 1, durationMs: 20, payloadBytes: 1200 },
          { scenarioId: 'observe-warm/orders', iteration: 0, durationMs: 10, payloadBytes: 1000 },
        ],
      },
    ]);
    const records = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      {
        durationMs: 10,
        iteration: 0,
        kind: 'sample',
        payloadBytes: 1000,
        scenarioId: 'observe-warm/orders',
      },
      {
        durationMs: 20,
        iteration: 1,
        kind: 'sample',
        payloadBytes: 1200,
        scenarioId: 'observe-warm/orders',
      },
    ]);
  });
});

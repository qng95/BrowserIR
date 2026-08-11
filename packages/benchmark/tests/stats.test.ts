import { describe, expect, it } from 'vitest';

import {
  bootstrapQuantileInterval,
  quantile,
  summarizeSamples,
} from '../src/stats.js';

describe('benchmark statistics', () => {
  it('uses a documented type-7 quantile and reports dispersion without trimming outliers', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10);

    expect(summarizeSamples([1, 2, 3, 4])).toEqual({
      count: 4,
      min: 1,
      max: 4,
      p50: 2.5,
      p95: 3.85,
      medianAbsoluteDeviation: 1,
    });
  });

  it('produces deterministic seeded bootstrap intervals', () => {
    const first = bootstrapQuantileInterval([1, 2, 3, 4, 5], 0.95, {
      confidence: 0.9,
      iterations: 500,
      seed: 42,
    });
    const second = bootstrapQuantileInterval([1, 2, 3, 4, 5], 0.95, {
      confidence: 0.9,
      iterations: 500,
      seed: 42,
    });

    expect(second).toEqual(first);
    expect(first.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.estimate);
  });

  it('rejects invalid or non-finite samples', () => {
    expect(() => quantile([], 0.5)).toThrow(/at least one sample/i);
    expect(() => quantile([1, Number.NaN], 0.5)).toThrow(/finite/i);
    expect(() => quantile([1], 1.1)).toThrow(/between 0 and 1/i);
  });
});

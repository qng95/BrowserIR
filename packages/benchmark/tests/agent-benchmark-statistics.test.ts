import { describe, expect, it } from 'vitest';

import { wilsonInterval } from '../src/agent-benchmark/statistics.js';

describe('agent benchmark statistics', () => {
  it('returns exact boundary intervals for no observations and all observations', () => {
    expect(wilsonInterval(0, 0)).toEqual({
      successes: 0,
      trials: 0,
      rate: 0,
      lower: 0,
      upper: 1,
      confidence: 0.95,
      method: 'wilson-score',
    });

    const allPassed = wilsonInterval(20, 20);
    expect(allPassed.rate).toBe(1);
    expect(allPassed.lower).toBeCloseTo(0.8388748, 6);
    expect(allPassed.upper).toBe(1);
  });

  it('computes a deterministic 95% interval for a partial success rate', () => {
    expect(wilsonInterval(7, 10)).toMatchObject({
      successes: 7,
      trials: 10,
      rate: 0.7,
      confidence: 0.95,
      method: 'wilson-score',
    });
    expect(wilsonInterval(7, 10).lower).toBeCloseTo(0.3967781, 6);
    expect(wilsonInterval(7, 10).upper).toBeCloseTo(0.8922087, 6);
  });

  it('rejects impossible counts instead of normalizing them silently', () => {
    expect(() => wilsonInterval(-1, 10)).toThrow('successes');
    expect(() => wilsonInterval(11, 10)).toThrow('successes');
    expect(() => wilsonInterval(1, -1)).toThrow('trials');
    expect(() => wilsonInterval(1.5, 2)).toThrow('successes');
  });
});

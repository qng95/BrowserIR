import { describe, expect, it } from 'vitest';

import {
  pairedHoeffdingLiftInterval,
  pairedLiftInterval,
} from '../src/agent-benchmark/index.js';

describe('paired agent benchmark statistics', () => {
  it('computes deterministic treatment-minus-control lift from matched binary outcomes', () => {
    const samples = [1, 1, 0, 0, -1] as const;
    const first = pairedLiftInterval(samples, { seed: 20260811, resamples: 10_000 });
    const second = pairedLiftInterval(samples, { seed: 20260811, resamples: 10_000 });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      estimate: 0.2,
      confidence: 0.95,
      method: 'paired-percentile-bootstrap',
      resamples: 10_000,
      seed: 20260811,
      pairs: 5,
    });
    if (first.estimate === null || first.lower === null || first.upper === null) {
      throw new Error('Expected a paired interval for valid samples.');
    }
    expect(first.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.estimate);
  });

  it('returns no interval when there are no valid pairs', () => {
    expect(pairedLiftInterval([], { seed: 7, resamples: 2_000 })).toEqual({
      estimate: null,
      lower: null,
      upper: null,
      confidence: 0.95,
      method: 'paired-percentile-bootstrap',
      resamples: 2_000,
      seed: 7,
      pairs: 0,
    });
  });

  it('keeps boundary uncertainty for one pair and supports a complete 30-pair result', () => {
    const one = pairedHoeffdingLiftInterval([1]);
    expect(one).toMatchObject({
      estimate: 1,
      lower: -1,
      upper: 1,
      method: 'paired-hoeffding-bound',
      pairs: 1,
    });

    const complete = pairedHoeffdingLiftInterval(Array.from({ length: 30 }, () => 1));
    expect(complete.estimate).toBe(1);
    expect(complete.lower).toBeGreaterThan(0);
    expect(complete.upper).toBe(1);
  });

  it('does not manufacture direction from balanced paired outcomes', () => {
    const interval = pairedHoeffdingLiftInterval([1, -1, 1, -1]);
    expect(interval.estimate).toBe(0);
    expect(interval.lower).toBeLessThanOrEqual(0);
    expect(interval.upper).toBeGreaterThanOrEqual(0);
  });
});

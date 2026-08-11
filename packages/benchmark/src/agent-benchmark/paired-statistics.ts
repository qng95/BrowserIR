import type { PairedLiftInterval } from './paired-contracts.js';

export interface PairedLiftIntervalOptions {
  seed: number;
  resamples: number;
}

const validateOptions = (options: PairedLiftIntervalOptions): void => {
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffff_ffff
  ) {
    throw new Error('Paired bootstrap seed must be an unsigned 32-bit integer.');
  }
  if (!Number.isInteger(options.resamples) || options.resamples < 1) {
    throw new Error('Paired bootstrap resamples must be a positive integer.');
  }
};

const quantile = (sorted: readonly number[], probability: number): number => {
  if (sorted.length === 0) throw new Error('Cannot calculate a quantile of no values.');
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const left = sorted[lower]!;
  const right = sorted[upper]!;
  return left + (right - left) * (position - lower);
};

const generator = (seed: number): (() => number) => {
  let state = seed === 0 ? 0x6d2b_79f5 : seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

export function pairedLiftInterval(
  samples: readonly (-1 | 0 | 1)[],
  options: PairedLiftIntervalOptions,
): PairedLiftInterval {
  validateOptions(options);
  if (samples.length === 0) {
    return {
      estimate: null,
      lower: null,
      upper: null,
      confidence: 0.95,
      method: 'paired-percentile-bootstrap',
      resamples: options.resamples,
      seed: options.seed,
      pairs: 0,
    };
  }
  const estimate = samples.reduce<number>((sum, value) => sum + value, 0) / samples.length;
  const random = generator(options.seed);
  const bootstrapped = Array.from({ length: options.resamples }, () => {
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      sum += samples[Math.floor(random() * samples.length)]!;
    }
    return sum / samples.length;
  }).sort((left, right) => left - right);
  return {
    estimate,
    lower: quantile(bootstrapped, 0.025),
    upper: quantile(bootstrapped, 0.975),
    confidence: 0.95,
    method: 'paired-percentile-bootstrap',
    resamples: options.resamples,
    seed: options.seed,
    pairs: samples.length,
  };
}

/**
 * Conservative two-sided 95% Hoeffding bound for the mean of paired outcomes
 * in [-1, 1]. Unlike an empirical percentile bootstrap, it retains uncertainty
 * when every observed pair has the same boundary outcome.
 */
export function pairedHoeffdingLiftInterval(
  samples: readonly (-1 | 0 | 1)[],
): PairedLiftInterval {
  if (samples.length === 0) {
    return {
      estimate: null,
      lower: null,
      upper: null,
      confidence: 0.95,
      method: 'paired-hoeffding-bound',
      pairs: 0,
    };
  }
  const estimate = samples.reduce<number>((sum, value) => sum + value, 0) / samples.length;
  const alpha = 0.05;
  const radius = Math.sqrt((2 * Math.log(2 / alpha)) / samples.length);
  return {
    estimate,
    lower: Math.max(-1, estimate - radius),
    upper: Math.min(1, estimate + radius),
    confidence: 0.95,
    method: 'paired-hoeffding-bound',
    pairs: samples.length,
  };
}

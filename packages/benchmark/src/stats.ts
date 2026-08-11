import type { BootstrapInterval, SampleSummary } from './schema.js';

const validatedSamples = (samples: readonly number[]): number[] => {
  if (samples.length === 0) {
    throw new Error('Benchmark statistics require at least one sample.');
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('Benchmark samples must all be finite numbers.');
  }
  return [...samples].sort((left, right) => left - right);
};

const precise = (value: number): number => Number(value.toFixed(12));

/** Hyndman and Fan type-7 quantile, matching the default used by R and NumPy. */
export function quantile(samples: readonly number[], probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Quantile probability must be between 0 and 1.');
  }
  const sorted = validatedSamples(samples);
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return precise(lower + (upper - lower) * (index - lowerIndex));
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  const sorted = validatedSamples(samples);
  const median = quantile(sorted, 0.5);
  const deviations = sorted.map((sample) => Math.abs(sample - median));
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    p50: median,
    p95: quantile(sorted, 0.95),
    medianAbsoluteDeviation: quantile(deviations, 0.5),
  };
}

export interface BootstrapOptions {
  confidence?: number;
  iterations?: number;
  seed?: number;
}

const seededRandom = (initialSeed: number): (() => number) => {
  let state = initialSeed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

export function bootstrapQuantileInterval(
  samples: readonly number[],
  probability: number,
  options: BootstrapOptions = {},
): BootstrapInterval {
  const source = validatedSamples(samples);
  const confidence = options.confidence ?? 0.95;
  const iterations = options.iterations ?? 2_000;
  const seed = options.seed ?? 0x42524952;
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error('Bootstrap confidence must be between 0 and 1.');
  }
  if (!Number.isInteger(iterations) || iterations < 100) {
    throw new Error('Bootstrap iterations must be an integer of at least 100.');
  }

  const random = seededRandom(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = Array.from(
      { length: source.length },
      () => source[Math.floor(random() * source.length)]!,
    );
    estimates.push(quantile(resample, probability));
  }
  const tail = (1 - confidence) / 2;
  return {
    estimate: quantile(source, probability),
    lower: quantile(estimates, tail),
    upper: quantile(estimates, 1 - tail),
    confidence,
    iterations,
    seed,
  };
}

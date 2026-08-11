import type { BinomialInterval } from './contracts.js';

const Z_95 = 1.959963984540054;

const nonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
};

export function wilsonInterval(successes: number, trials: number): BinomialInterval {
  nonNegativeInteger(trials, 'trials');
  nonNegativeInteger(successes, 'successes');
  if (successes > trials) throw new Error('successes must not exceed trials.');
  if (trials === 0) {
    return {
      successes,
      trials,
      rate: 0,
      lower: 0,
      upper: 1,
      confidence: 0.95,
      method: 'wilson-score',
    };
  }

  const rate = successes / trials;
  const zSquared = Z_95 * Z_95;
  const denominator = 1 + zSquared / trials;
  const center = (rate + zSquared / (2 * trials)) / denominator;
  const margin =
    (Z_95 / denominator) *
    Math.sqrt((rate * (1 - rate)) / trials + zSquared / (4 * trials * trials));

  return {
    successes,
    trials,
    rate,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    confidence: 0.95,
    method: 'wilson-score',
  };
}

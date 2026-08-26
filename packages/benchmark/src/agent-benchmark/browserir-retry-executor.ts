import type { BrowserIrRetryMode } from './browserir-retry-analysis.js';

/** Keeps attempt-one seeds invariant when max_retry changes. */
export const BROWSERIR_RETRY_SEED_ATTEMPT_STRIDE = 1_000_000 as const;

export interface BrowserIrRetryExecutionCell {
  readonly mode: BrowserIrRetryMode;
  readonly attemptNumber: number;
  readonly retryIndex: number;
  /** Shared by off/auto at the same task and attempt number. */
  readonly seed: number;
}

/**
 * Executes evaluator-supervised retries on fresh arm runtimes. The callback is
 * responsible for creating that fresh runtime and never receives oracle output
 * from a previous attempt.
 */
export async function executeBrowserIrFreshStateRetryPair<
  Result extends Readonly<{ exactOracleSuccess: boolean }>,
>(input: Readonly<{
  pairIndex: number;
  maxRetries: number;
  baseSeed: number;
  runAttempt(cell: BrowserIrRetryExecutionCell): Promise<Result>;
}>): Promise<readonly Result[]> {
  if (!Number.isSafeInteger(input.pairIndex) || input.pairIndex < 0) {
    throw new Error('Retry pairIndex must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 5) {
    throw new Error('Retry maxRetries must be an integer in [0, 5].');
  }
  if (!Number.isSafeInteger(input.baseSeed) || input.baseSeed < 0) {
    throw new Error('Retry baseSeed must be a non-negative safe integer.');
  }
  const maxAttempts = input.maxRetries + 1;
  const finalSeed = input.baseSeed + input.pairIndex +
    input.maxRetries * BROWSERIR_RETRY_SEED_ATTEMPT_STRIDE;
  if (!Number.isSafeInteger(finalSeed)) throw new Error('Retry seed schedule exceeds safe integers.');
  const solved: Record<BrowserIrRetryMode, boolean> = { off: false, auto: false };
  const results: Result[] = [];
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const seed = input.baseSeed + input.pairIndex +
      (attemptNumber - 1) * BROWSERIR_RETRY_SEED_ATTEMPT_STRIDE;
    const order: readonly BrowserIrRetryMode[] =
      (input.pairIndex + attemptNumber - 1) % 2 === 0
        ? ['off', 'auto']
        : ['auto', 'off'];
    for (const mode of order) {
      if (solved[mode]) continue;
      const result = await input.runAttempt(Object.freeze({
        mode,
        attemptNumber,
        retryIndex: attemptNumber - 1,
        seed,
      }));
      results.push(result);
      solved[mode] = result.exactOracleSuccess;
    }
    if (solved.off && solved.auto) break;
  }
  return Object.freeze(results);
}

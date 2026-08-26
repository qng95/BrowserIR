import { describe, expect, it } from 'vitest';

import { executeBrowserIrFreshStateRetryPair } from
  '../src/agent-benchmark/browserir-retry-executor.js';

describe('Browser IR fresh-state retry executor', () => {
  it('shares seeds within an attempt and stops each mode immediately after success', async () => {
    const calls: Array<Readonly<{
      mode: 'off' | 'auto'; attemptNumber: number; retryIndex: number; seed: number;
    }>> = [];
    const results = await executeBrowserIrFreshStateRetryPair({
      pairIndex: 0,
      maxRetries: 2,
      baseSeed: 100,
      async runAttempt(cell) {
        calls.push(cell);
        return { exactOracleSuccess:
          cell.mode === 'auto' || (cell.mode === 'off' && cell.attemptNumber === 2) };
      },
    });

    expect(calls).toEqual([
      { mode: 'off', attemptNumber: 1, retryIndex: 0, seed: 100 },
      { mode: 'auto', attemptNumber: 1, retryIndex: 0, seed: 100 },
      { mode: 'off', attemptNumber: 2, retryIndex: 1, seed: 1_000_100 },
    ]);
    expect(results).toHaveLength(3);
  });

  it('alternates within-pair order and exhausts max_retry only for unsolved modes', async () => {
    const calls: Array<Readonly<{
      mode: 'off' | 'auto'; attemptNumber: number; seed: number;
    }>> = [];
    await executeBrowserIrFreshStateRetryPair({
      pairIndex: 1,
      maxRetries: 2,
      baseSeed: 100,
      async runAttempt(cell) {
        calls.push(cell);
        return { exactOracleSuccess: false };
      },
    });

    expect(calls).toEqual([
      { mode: 'auto', attemptNumber: 1, retryIndex: 0, seed: 101 },
      { mode: 'off', attemptNumber: 1, retryIndex: 0, seed: 101 },
      { mode: 'off', attemptNumber: 2, retryIndex: 1, seed: 1_000_101 },
      { mode: 'auto', attemptNumber: 2, retryIndex: 1, seed: 1_000_101 },
      { mode: 'auto', attemptNumber: 3, retryIndex: 2, seed: 2_000_101 },
      { mode: 'off', attemptNumber: 3, retryIndex: 2, seed: 2_000_101 },
    ]);
  });
});

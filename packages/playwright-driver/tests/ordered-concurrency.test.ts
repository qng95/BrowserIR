import { describe, expect, it } from 'vitest';

import { mapOrderedConcurrent } from '../src/ordered-concurrency.js';

describe('mapOrderedConcurrent', () => {
  it('bounds active work while preserving input order', async () => {
    const releases = new Map<number, () => void>();
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;

    const resultPromise = mapOrderedConcurrent([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.set(value, resolve);
      });
      active -= 1;
      return `result-${value}`;
    });

    await expect.poll(() => started).toEqual([0, 1]);
    releases.get(1)!();
    await expect.poll(() => started).toEqual([0, 1, 2]);
    releases.get(0)!();
    await expect.poll(() => started).toEqual([0, 1, 2, 3]);
    releases.get(3)!();
    await expect.poll(() => started).toEqual([0, 1, 2, 3, 4]);
    releases.get(2)!();
    releases.get(4)!();

    await expect(resultPromise).resolves.toEqual([
      'result-0',
      'result-1',
      'result-2',
      'result-3',
      'result-4',
    ]);
    expect(maxActive).toBe(2);
  });

  it('propagates worker failures', async () => {
    const failure = new Error('observation failed');

    await expect(
      mapOrderedConcurrent([0, 1, 2], 2, async (value) => {
        if (value === 1) throw failure;
        return value;
      }),
    ).rejects.toBe(failure);
  });

  it('preserves the first rejection when another in-flight worker rejects later', async () => {
    const firstFailure = new Error('first failure');
    const laterFailure = new Error('later failure');
    const rejectors = new Map<number, (reason: unknown) => void>();
    const started: number[] = [];

    const resultPromise = mapOrderedConcurrent([0, 1], 2, async (value) => {
      started.push(value);
      await new Promise<never>((_resolve, reject) => {
        rejectors.set(value, reject);
      });
    });
    const rejection = expect(resultPromise).rejects.toBe(firstFailure);

    await expect.poll(() => started).toEqual([0, 1]);
    rejectors.get(1)!(firstFailure);
    await Promise.resolve();
    rejectors.get(0)!(laterFailure);

    await rejection;
  });

  it('propagates an undefined rejection reason', async () => {
    await expect(
      mapOrderedConcurrent([0], 1, async () => Promise.reject(undefined)),
    ).rejects.toBeUndefined();
  });
});

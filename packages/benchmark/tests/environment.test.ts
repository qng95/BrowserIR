import { describe, expect, it } from 'vitest';

import {
  environmentFingerprint,
  stableJson,
  type BenchmarkEnvironment,
} from '../src/environment.js';

describe('benchmark environment metadata', () => {
  it('fingerprints semantic metadata independent of object insertion order', () => {
    const left = {
      os: { platform: 'linux', release: 'x', arch: 'x64' },
      runtime: { node: '22', pnpm: '10' },
      browser: { playwright: '1', chromium: '2', headless: true },
      profile: { viewport: '1440x900', deviceScaleFactor: 1 },
    } satisfies BenchmarkEnvironment;
    const right = {
      profile: { deviceScaleFactor: 1, viewport: '1440x900' },
      browser: { headless: true, chromium: '2', playwright: '1' },
      runtime: { pnpm: '10', node: '22' },
      os: { arch: 'x64', release: 'x', platform: 'linux' },
    } satisfies BenchmarkEnvironment;

    expect(stableJson(left)).toBe(stableJson(right));
    expect(environmentFingerprint(left)).toBe(environmentFingerprint(right));
    expect(environmentFingerprint(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps source provenance without making cross-revision comparisons impossible', () => {
    const common = {
      os: { platform: 'linux', release: 'x', arch: 'x64' },
      runtime: { node: '22', pnpm: '10' },
      browser: { playwright: '1', chromium: '2', headless: true },
      profile: { viewport: '1440x900', deviceScaleFactor: 1 },
      hardware: { cpuModel: 'test', logicalCpus: 8, memoryBytes: 16_000 },
    } satisfies BenchmarkEnvironment;
    const baseline = {
      ...common,
      source: { revision: 'baseline', dirty: false },
    } satisfies BenchmarkEnvironment;
    const candidate = {
      ...common,
      source: { revision: 'candidate', dirty: true },
    } satisfies BenchmarkEnvironment;

    expect(environmentFingerprint(candidate)).toBe(environmentFingerprint(baseline));
    expect(
      environmentFingerprint({
        ...candidate,
        hardware: { ...candidate.hardware, logicalCpus: 4 },
      }),
    ).not.toBe(environmentFingerprint(baseline));
    expect(
      environmentFingerprint({
        ...candidate,
        workload: { kind: 'warm-observation', maxCharacters: 8_000 },
      }),
    ).not.toBe(environmentFingerprint(baseline));
  });
});

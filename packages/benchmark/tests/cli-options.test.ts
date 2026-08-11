import { describe, expect, it } from 'vitest';

import {
  parseBenchmarkCliOptions,
  resolveBenchmarkOutputDirectory,
} from '../src/cli-options.js';

describe('benchmark CLI options', () => {
  it('defaults to the statistically meaningful release profile', () => {
    expect(parseBenchmarkCliOptions([])).toMatchObject({
      warmups: 5,
      samples: 100,
      headless: true,
      maxCharacters: 16000,
      targetIds: [],
    });
  });

  it('accepts explicit quick-run and target options', () => {
    expect(
      parseBenchmarkCliOptions([
        '--warmups', '1', '--samples', '3', '--max-characters', '8000',
        '--output', '/tmp/browserir-bench', '--run-id', 'rc-1', '--headful',
        '--target', 'observe-warm/orders-draft-table', '--target', 'observe-warm/query-builder',
      ]),
    ).toEqual({
      warmups: 1,
      samples: 3,
      maxCharacters: 8000,
      outputDirectory: '/tmp/browserir-bench',
      runId: 'rc-1',
      headless: false,
      targetIds: ['observe-warm/orders-draft-table', 'observe-warm/query-builder'],
    });
  });

  it('rejects missing, unknown, and invalid values', () => {
    expect(() => parseBenchmarkCliOptions(['--samples', '0'])).toThrow(/samples.*positive/i);
    expect(() => parseBenchmarkCliOptions(['--warmups'])).toThrow(/warmups.*value/i);
    expect(() => parseBenchmarkCliOptions(['--wat'])).toThrow(/unknown option/i);
    expect(() => parseBenchmarkCliOptions(['--run-id', '../overwrite'])).toThrow(/run-id/i);
    expect(() => parseBenchmarkCliOptions(['--run-id', 'one', '--run-id', 'two'])).toThrow(
      /duplicate.*run-id/i,
    );
  });

  it('resolves relative outputs from the workspace rather than the package process cwd', () => {
    expect(resolveBenchmarkOutputDirectory('/workspace', undefined, 'run-1')).toBe(
      '/workspace/output/benchmarks/run-1',
    );
    expect(resolveBenchmarkOutputDirectory('/workspace', 'reports/test', 'run-1')).toBe(
      '/workspace/reports/test',
    );
  });
});

import { describe, expect, it } from 'vitest';

import {
  parseRepresentationCliOptions,
  resolveRepresentationOutputDirectory,
} from '../src/representation-cli-options.js';

describe('representation benchmark CLI options', () => {
  it('uses a fixed release profile by default', () => {
    expect(parseRepresentationCliOptions([])).toEqual({ headless: true });
  });

  it('accepts an immutable output target, explicit run ID, and diagnostic headful mode', () => {
    expect(
      parseRepresentationCliOptions([
        '--output',
        '/tmp/browserir-representation',
        '--run-id',
        'candidate-7',
        '--headful',
      ]),
    ).toEqual({
      outputDirectory: '/tmp/browserir-representation',
      runId: 'candidate-7',
      headless: false,
    });
  });

  it('rejects missing, duplicate, empty, and unknown values', () => {
    expect(() => parseRepresentationCliOptions(['--output'])).toThrow(/requires a value/i);
    expect(() =>
      parseRepresentationCliOptions(['--run-id', 'first', '--run-id', 'second']),
    ).toThrow(/duplicate/i);
    expect(() => parseRepresentationCliOptions(['--run-id', '   '])).toThrow(/must not be empty/i);
    expect(() => parseRepresentationCliOptions(['--run-id', '../../escape'])).toThrow(/safe filename/i);
    expect(() => parseRepresentationCliOptions(['--samples', '3'])).toThrow(/unknown option/i);
  });

  it('resolves the default below the workspace output directory', () => {
    expect(
      resolveRepresentationOutputDirectory('/workspace', undefined, 'candidate-7'),
    ).toBe('/workspace/output/benchmarks/representation-candidate-7');
  });
});

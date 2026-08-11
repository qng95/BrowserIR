import { describe, expect, it } from 'vitest';

import {
  PAIRED_UPLIFT_CLI_USAGE,
  parsePairedUpliftCliOptions,
  resolvePairedUpliftOutputDirectory,
} from '../src/uplift-cli-options.js';

describe('paired uplift CLI options', () => {
  it('requires a protocol and keeps scored settings out of CLI overrides', () => {
    expect(PAIRED_UPLIFT_CLI_USAGE).toContain('--protocol FILE');
    expect(() => parsePairedUpliftCliOptions([])).toThrow(/--protocol is required/i);

    expect(parsePairedUpliftCliOptions(['--protocol', 'drop-01.json'])).toEqual({
      protocolPath: 'drop-01.json',
    });
  });

  it('allows only an output location override', () => {
    expect(
      parsePairedUpliftCliOptions([
        '--protocol',
        'drop-01.json',
        '--output',
        '/tmp/drop-01',
      ]),
    ).toEqual({ protocolPath: 'drop-01.json', outputDirectory: '/tmp/drop-01' });

    expect(() =>
      parsePairedUpliftCliOptions(['--protocol', 'drop-01.json', '--model', 'better-model']),
    ).toThrow(/unknown option/i);
  });

  it('accepts an explicit resume directory and rejects output ambiguity', () => {
    expect(
      parsePairedUpliftCliOptions([
        '--protocol',
        'drop-01.json',
        '--resume',
        '/tmp/drop-01',
      ]),
    ).toEqual({ protocolPath: 'drop-01.json', resumeDirectory: '/tmp/drop-01' });

    expect(() =>
      parsePairedUpliftCliOptions([
        '--protocol',
        'drop-01.json',
        '--output',
        '/tmp/new',
        '--resume',
        '/tmp/existing',
      ]),
    ).toThrow(/output.*resume|resume.*output/i);
  });

  it('rejects duplicate, missing, and blank values', () => {
    expect(() => parsePairedUpliftCliOptions(['--protocol'])).toThrow(/requires a value/i);
    expect(() =>
      parsePairedUpliftCliOptions([
        '--protocol',
        'one.json',
        '--protocol',
        'two.json',
      ]),
    ).toThrow(/duplicate.*protocol/i);
    expect(() =>
      parsePairedUpliftCliOptions(['--protocol', 'drop-01.json', '--output', '']),
    ).toThrow(/output.*empty/i);
  });

  it('resolves relative protocol and output paths from the workspace root', () => {
    expect(resolvePairedUpliftOutputDirectory('/workspace', undefined, 'drop-01')).toBe(
      '/workspace/output/benchmarks/drop-01',
    );
    expect(resolvePairedUpliftOutputDirectory('/workspace', 'evidence/drop-01', 'drop-01')).toBe(
      '/workspace/evidence/drop-01',
    );
    expect(resolvePairedUpliftOutputDirectory('/workspace', '/tmp/drop-01', 'drop-01')).toBe(
      '/tmp/drop-01',
    );
  });
});

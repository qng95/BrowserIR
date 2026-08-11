import { describe, expect, it } from 'vitest';

import {
  CONTROL_CAPABILITY_CLI_USAGE,
  parseControlCapabilityCliOptions,
  resolveControlCapabilityOutputDirectory,
} from '../src/control-capability-cli-options.js';

describe('control capability CLI options', () => {
  it('requires a protocol and keeps every qualification setting in the manifest', () => {
    expect(CONTROL_CAPABILITY_CLI_USAGE).toContain('--protocol FILE');
    expect(CONTROL_CAPABILITY_CLI_USAGE).toContain('score-excluded');
    expect(() => parseControlCapabilityCliOptions([])).toThrow(/--protocol is required/i);

    expect(
      parseControlCapabilityCliOptions([
        '--protocol',
        'docs/evidence-drops/drop-01/control-capability-v1.protocol.json',
      ]),
    ).toEqual({
      protocolPath: 'docs/evidence-drops/drop-01/control-capability-v1.protocol.json',
    });
  });

  it('allows only a create-only output location override', () => {
    expect(
      parseControlCapabilityCliOptions([
        '--protocol',
        'control.json',
        '--output',
        '/tmp/control-capability',
      ]),
    ).toEqual({
      protocolPath: 'control.json',
      outputDirectory: '/tmp/control-capability',
    });

    for (const forbidden of ['--model', '--trials', '--task', '--temperature', '--resume']) {
      expect(() =>
        parseControlCapabilityCliOptions([
          '--protocol',
          'control.json',
          forbidden,
          'override',
        ]),
      ).toThrow(/unknown option/i);
    }
  });

  it('rejects duplicate, missing, and blank values', () => {
    expect(() => parseControlCapabilityCliOptions(['--protocol'])).toThrow(
      /requires a value/i,
    );
    expect(() =>
      parseControlCapabilityCliOptions([
        '--protocol',
        'one.json',
        '--protocol',
        'two.json',
      ]),
    ).toThrow(/duplicate.*protocol/i);
    expect(() =>
      parseControlCapabilityCliOptions(['--protocol', 'control.json', '--output', '']),
    ).toThrow(/output.*empty/i);
  });

  it('resolves relative output paths from the workspace root', () => {
    expect(
      resolveControlCapabilityOutputDirectory('/workspace', undefined, 'control-v1'),
    ).toBe('/workspace/output/benchmarks/control-v1');
    expect(
      resolveControlCapabilityOutputDirectory(
        '/workspace',
        'evidence/control-v1',
        'control-v1',
      ),
    ).toBe('/workspace/evidence/control-v1');
    expect(
      resolveControlCapabilityOutputDirectory(
        '/workspace',
        '/tmp/control-v1',
        'control-v1',
      ),
    ).toBe('/tmp/control-v1');
  });
});

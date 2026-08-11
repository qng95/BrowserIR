import { describe, expect, it } from 'vitest';

import {
  AGENT_BENCHMARK_CLI_USAGE,
  parseAgentBenchmarkCliOptions,
  resolveAgentBenchmarkOutputDirectory,
} from '../src/agent-cli-options.js';

describe('agent benchmark CLI options', () => {
  it('requires an explicit model and defaults to a development-sized run', () => {
    expect(AGENT_BENCHMARK_CLI_USAGE).toContain('--model MODEL_ID');
    expect(() => parseAgentBenchmarkCliOptions([])).toThrow(/--model is required/i);

    expect(parseAgentBenchmarkCliOptions(['--model', 'gpt-5-mini'])).toEqual({
      model: 'gpt-5-mini',
      temperature: 0,
      trials: 1,
      maxDurationMs: 120_000,
      maxToolCalls: 100,
      maxModelTurns: 30,
      headless: true,
      imageMode: 'text-only',
      taskIds: [],
    });
  });

  it('accepts task filters, budgets, reproducibility settings, and headful mode', () => {
    expect(
      parseAgentBenchmarkCliOptions([
        '--model',
        'gpt-5.1',
        '--temperature',
        '0.25',
        '--task',
        'create-customer',
        '--task',
        'highest-revenue-poland',
        '--trials',
        '3',
        '--max-duration-ms',
        '90000',
        '--max-tool-calls',
        '64',
        '--max-model-turns',
        '24',
        '--run-id',
        'candidate-7',
        '--output',
        '/tmp/browserir-agent',
        '--headful',
        '--multimodal',
      ]),
    ).toEqual({
      model: 'gpt-5.1',
      temperature: 0.25,
      trials: 3,
      maxDurationMs: 90_000,
      maxToolCalls: 64,
      maxModelTurns: 24,
      runId: 'candidate-7',
      outputDirectory: '/tmp/browserir-agent',
      headless: false,
      imageMode: 'multimodal',
      taskIds: ['create-customer', 'highest-revenue-poland'],
    });
  });

  it('rejects missing, duplicate, malformed, and unknown arguments', () => {
    expect(() => parseAgentBenchmarkCliOptions(['--model'])).toThrow(/requires a value/i);
    expect(() =>
      parseAgentBenchmarkCliOptions(['--model', 'first', '--model', 'second']),
    ).toThrow(/duplicate.*model/i);
    expect(() =>
      parseAgentBenchmarkCliOptions(['--model', 'gpt', '--task', 'one', '--task', 'one']),
    ).toThrow(/duplicate task/i);
    expect(() =>
      parseAgentBenchmarkCliOptions(['--model', 'gpt', '--trials', '0']),
    ).toThrow(/trials.*positive/i);
    expect(() =>
      parseAgentBenchmarkCliOptions(['--model', 'gpt', '--max-tool-calls', '1.5']),
    ).toThrow(/max-tool-calls.*positive/i);
    expect(() =>
      parseAgentBenchmarkCliOptions(['--model', 'gpt', '--temperature', '-0.1']),
    ).toThrow(/temperature.*between 0 and 2/i);
    expect(() =>
      parseAgentBenchmarkCliOptions(['--model', 'gpt', '--temperature', 'NaN']),
    ).toThrow(/temperature.*between 0 and 2/i);
    expect(() =>
      parseAgentBenchmarkCliOptions(['--model', 'gpt', '--run-id', '../escape']),
    ).toThrow(/run-id.*safe filename/i);
    expect(() => parseAgentBenchmarkCliOptions(['--model', 'gpt', '--wat'])).toThrow(
      /unknown option/i,
    );
  });

  it('resolves relative output paths from the workspace root', () => {
    expect(resolveAgentBenchmarkOutputDirectory('/workspace', undefined, 'candidate-7')).toBe(
      '/workspace/output/benchmarks/agent-candidate-7',
    );
    expect(resolveAgentBenchmarkOutputDirectory('/workspace', 'reports/agent', 'candidate-7')).toBe(
      '/workspace/reports/agent',
    );
    expect(resolveAgentBenchmarkOutputDirectory('/workspace', '/tmp/agent', 'candidate-7')).toBe(
      '/tmp/agent',
    );
  });
});

import { isAbsolute, resolve } from 'node:path';

export interface BenchmarkCliOptions {
  warmups: number;
  samples: number;
  maxCharacters: number;
  outputDirectory?: string;
  runId?: string;
  headless: boolean;
  targetIds: string[];
}

const valueAfter = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

const integer = (
  raw: string,
  label: string,
  allowZero: boolean,
): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(
      `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`,
    );
  }
  return value;
};

export function parseBenchmarkCliOptions(
  args: readonly string[],
): BenchmarkCliOptions {
  let warmups = 5;
  let samples = 100;
  let maxCharacters = 16_000;
  let outputDirectory: string | undefined;
  let runId: string | undefined;
  let headless = true;
  const targetIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === '--headful') {
      headless = false;
      continue;
    }
    if (option === '--warmups') {
      warmups = integer(valueAfter(args, index, option), 'warmups', true);
      index += 1;
      continue;
    }
    if (option === '--samples') {
      samples = integer(valueAfter(args, index, option), 'samples', false);
      index += 1;
      continue;
    }
    if (option === '--max-characters') {
      maxCharacters = integer(
        valueAfter(args, index, option),
        'max-characters',
        false,
      );
      index += 1;
      continue;
    }
    if (option === '--output') {
      outputDirectory = valueAfter(args, index, option);
      index += 1;
      continue;
    }
    if (option === '--run-id') {
      if (runId !== undefined) throw new Error('Duplicate --run-id option.');
      const value = valueAfter(args, index, option);
      if (!/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error('--run-id may contain only letters, digits, dot, underscore, and hyphen.');
      }
      runId = value;
      index += 1;
      continue;
    }
    if (option === '--target') {
      const targetId = valueAfter(args, index, option);
      if (targetIds.includes(targetId)) {
        throw new Error(`Duplicate target option: ${targetId}.`);
      }
      targetIds.push(targetId);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${option}.`);
  }

  return {
    warmups,
    samples,
    maxCharacters,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(runId === undefined ? {} : { runId }),
    headless,
    targetIds,
  };
}

export function resolveBenchmarkOutputDirectory(
  workspaceRoot: string,
  requested: string | undefined,
  runId: string,
): string {
  const path = requested ?? `output/benchmarks/${runId}`;
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

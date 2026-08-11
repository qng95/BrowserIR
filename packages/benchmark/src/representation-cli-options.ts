import { isAbsolute, resolve } from 'node:path';

export interface RepresentationCliOptions {
  outputDirectory?: string;
  runId?: string;
  headless: boolean;
}

const valueAfter = (
  args: readonly string[],
  index: number,
  option: string,
): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

export function parseRepresentationCliOptions(
  args: readonly string[],
): RepresentationCliOptions {
  let outputDirectory: string | undefined;
  let runId: string | undefined;
  let headless = true;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === '--headful') {
      headless = false;
      continue;
    }
    if (option === '--output' || option === '--run-id') {
      const value = valueAfter(args, index, option);
      if (value.trim() === '') {
        throw new Error(`${option.slice(2)} must not be empty.`);
      }
      if (
        option === '--run-id' &&
        (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.length > 128)
      ) {
        throw new Error(
          'run-id must be a safe filename component of at most 128 characters.',
        );
      }
      if (option === '--output') {
        if (outputDirectory !== undefined) {
          throw new Error('Duplicate --output option.');
        }
        outputDirectory = value;
      } else {
        if (runId !== undefined) throw new Error('Duplicate --run-id option.');
        runId = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${option}.`);
  }

  return {
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(runId === undefined ? {} : { runId }),
    headless,
  };
}

export function resolveRepresentationOutputDirectory(
  workspaceRoot: string,
  requested: string | undefined,
  runId: string,
): string {
  const path = requested ?? `output/benchmarks/representation-${runId}`;
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

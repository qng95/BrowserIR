import { isAbsolute, resolve } from 'node:path';

export const PAIRED_UPLIFT_CLI_USAGE = `BrowserIR paired uplift benchmark

Usage:
  pnpm benchmark:uplift -- --protocol FILE [options]

Options:
  --protocol FILE           Machine-readable development or frozen protocol
  --output DIRECTORY        Create-only evidence directory
  --resume DIRECTORY        Resume an interrupted create-only evidence directory
  --help, -h                Show this help without invoking a model

Model, task, prompt, schedule, budgets, and arms come only from the protocol.
`;

export interface PairedUpliftCliOptions {
  protocolPath: string;
  outputDirectory?: string | undefined;
  resumeDirectory?: string | undefined;
}

const valueAfter = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

export function parsePairedUpliftCliOptions(
  args: readonly string[],
): PairedUpliftCliOptions {
  let protocolPath: string | undefined;
  let outputDirectory: string | undefined;
  let resumeDirectory: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option !== '--protocol' && option !== '--output' && option !== '--resume') {
      throw new Error(`Unknown option: ${option}.`);
    }
    if (seen.has(option)) throw new Error(`Duplicate ${option} option.`);
    seen.add(option);
    const value = valueAfter(args, index, option);
    if (value.trim().length === 0) {
      throw new Error(`${option.slice(2)} must not be empty.`);
    }
    if (option === '--protocol') protocolPath = value;
    else if (option === '--output') outputDirectory = value;
    else resumeDirectory = value;
    index += 1;
  }
  if (protocolPath === undefined) throw new Error('--protocol is required.');
  if (outputDirectory !== undefined && resumeDirectory !== undefined) {
    throw new Error('--output and --resume cannot be used together.');
  }
  return {
    protocolPath,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(resumeDirectory === undefined ? {} : { resumeDirectory }),
  };
}

export function resolvePairedUpliftOutputDirectory(
  workspaceRoot: string,
  requested: string | undefined,
  runId: string,
): string {
  const path = requested ?? `output/benchmarks/${runId}`;
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

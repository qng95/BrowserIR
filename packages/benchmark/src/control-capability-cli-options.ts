import { isAbsolute, resolve } from 'node:path';

export const CONTROL_CAPABILITY_CLI_USAGE = `BrowserIR control capability qualification

Usage:
  pnpm benchmark:control-capability -- --protocol FILE [options]

Options:
  --protocol FILE           Machine-readable score-excluded qualification protocol
  --output DIRECTORY        Create-only evidence directory
  --help, -h                Show this help without invoking a model

The task, five-attempt schedule, model, prompt, provider, browser profile,
budgets, decision rule, and official Playwright MCP control come only from the
protocol. This command cannot produce a BrowserIR uplift score.
`;

export interface ControlCapabilityCliOptions {
  protocolPath: string;
  outputDirectory?: string | undefined;
}

const valueAfter = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

export function parseControlCapabilityCliOptions(
  args: readonly string[],
): ControlCapabilityCliOptions {
  let protocolPath: string | undefined;
  let outputDirectory: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option !== '--protocol' && option !== '--output') {
      throw new Error(`Unknown option: ${option}.`);
    }
    if (seen.has(option)) throw new Error(`Duplicate ${option} option.`);
    seen.add(option);
    const value = valueAfter(args, index, option);
    if (value.trim().length === 0) {
      throw new Error(`${option.slice(2)} must not be empty.`);
    }
    if (option === '--protocol') protocolPath = value;
    else outputDirectory = value;
    index += 1;
  }

  if (protocolPath === undefined) throw new Error('--protocol is required.');
  return {
    protocolPath,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
}

export function resolveControlCapabilityOutputDirectory(
  workspaceRoot: string,
  requested: string | undefined,
  runId: string,
): string {
  const path = requested ?? `output/benchmarks/${runId}`;
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

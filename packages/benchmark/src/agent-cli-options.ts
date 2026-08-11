import { isAbsolute, resolve } from 'node:path';

export const AGENT_BENCHMARK_CLI_USAGE = `BrowserIR agent benchmark

Usage:
  pnpm benchmark:agent -- --model MODEL_ID [options]

Options:
  --task ID                 Run one task; repeat to select multiple tasks
  --trials N                Independent attempts per task (default: 1)
  --temperature N           Provider temperature from 0 to 2 (default: 0)
  --max-duration-ms N       Wall-clock budget per attempt (default: 120000)
  --max-tool-calls N        Tool-call budget per attempt (default: 100)
  --max-model-turns N       Model-call budget per attempt (default: 30)
  --run-id ID               Filesystem-safe run identifier
  --output DIRECTORY        Create-only artifact directory
  --headful                 Diagnostic visible-browser profile
  --multimodal              Forward screenshots to a vision-capable model
  --help, -h                Show this help without invoking a model
`;

export interface AgentBenchmarkCliOptions {
  model: string;
  temperature: number;
  trials: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxModelTurns: number;
  outputDirectory?: string | undefined;
  runId?: string | undefined;
  headless: boolean;
  imageMode: 'text-only' | 'multimodal';
  taskIds: string[];
}

const valueAfter = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

const positiveInteger = (raw: string, option: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${option.slice(2)} must be a positive integer.`);
  }
  return value;
};

const temperatureValue = (raw: string): number => {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error('temperature must be a finite number between 0 and 2.');
  }
  return value;
};

export function parseAgentBenchmarkCliOptions(
  args: readonly string[],
): AgentBenchmarkCliOptions {
  let model: string | undefined;
  let temperature = 0;
  let trials = 1;
  let maxDurationMs = 120_000;
  let maxToolCalls = 100;
  let maxModelTurns = 30;
  let outputDirectory: string | undefined;
  let runId: string | undefined;
  let headless = true;
  let imageMode: 'text-only' | 'multimodal' = 'text-only';
  const taskIds: string[] = [];
  const seen = new Set<string>();

  const rejectDuplicate = (option: string): void => {
    if (seen.has(option)) throw new Error(`Duplicate ${option} option.`);
    seen.add(option);
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === '--headful') {
      rejectDuplicate(option);
      headless = false;
      continue;
    }
    if (option === '--multimodal') {
      rejectDuplicate(option);
      imageMode = 'multimodal';
      continue;
    }
    if (option === '--task') {
      const taskId = valueAfter(args, index, option);
      if (taskId.trim() === '') throw new Error('task must not be empty.');
      if (taskIds.includes(taskId)) throw new Error(`Duplicate task option: ${taskId}.`);
      taskIds.push(taskId);
      index += 1;
      continue;
    }
    if (
      option === '--model' ||
      option === '--temperature' ||
      option === '--trials' ||
      option === '--max-duration-ms' ||
      option === '--max-tool-calls' ||
      option === '--max-model-turns' ||
      option === '--output' ||
      option === '--run-id'
    ) {
      rejectDuplicate(option);
      const value = valueAfter(args, index, option);
      if (option === '--model') {
        if (value.trim() === '') throw new Error('model must not be empty.');
        model = value;
      } else if (option === '--temperature') {
        temperature = temperatureValue(value);
      } else if (option === '--trials') {
        trials = positiveInteger(value, option);
      } else if (option === '--max-duration-ms') {
        maxDurationMs = positiveInteger(value, option);
      } else if (option === '--max-tool-calls') {
        maxToolCalls = positiveInteger(value, option);
      } else if (option === '--max-model-turns') {
        maxModelTurns = positiveInteger(value, option);
      } else if (option === '--output') {
        if (value.trim() === '') throw new Error('output must not be empty.');
        outputDirectory = value;
      } else {
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
          value.length > 128
        ) {
          throw new Error(
            'run-id must be a safe filename component of at most 128 characters.',
          );
        }
        runId = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${option}.`);
  }

  if (model === undefined) throw new Error('--model is required; there is no default model.');

  return {
    model,
    temperature,
    trials,
    maxDurationMs,
    maxToolCalls,
    maxModelTurns,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(runId === undefined ? {} : { runId }),
    headless,
    imageMode,
    taskIds,
  };
}

export function resolveAgentBenchmarkOutputDirectory(
  workspaceRoot: string,
  requested: string | undefined,
  runId: string,
): string {
  const path = requested ?? `output/benchmarks/agent-${runId}`;
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

import { fileURLToPath } from 'node:url';

import { ChatOpenAI } from '@langchain/openai';

import {
  AGENT_BENCHMARK_CLI_USAGE,
  parseAgentBenchmarkCliOptions,
  resolveAgentBenchmarkOutputDirectory,
} from './agent-cli-options.js';
import {
  createFixtureAgentTargetFactory,
  createLangChainBrowserAgent,
  fixtureAgentTargetVersion,
  fixtureAgentTasks,
  runAgentBenchmark,
  writeAgentBenchmarkArtifacts,
} from './agent-benchmark/index.js';

const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(AGENT_BENCHMARK_CLI_USAGE);
    return;
  }
  const options = parseAgentBenchmarkCliOptions(args);
  const tasks = fixtureAgentTasks(options.taskIds.length === 0 ? undefined : options.taskIds);
  const runId = options.runId ?? `openai-${timestamp()}`;
  const outputDirectory = resolveAgentBenchmarkOutputDirectory(
    workspaceRoot,
    options.outputDirectory,
    runId,
  );
  const modelConfiguration = Object.freeze({
    provider: 'openai',
    temperature: options.temperature,
    maxRetries: 0,
    useResponsesApi: false,
    imageMode: options.imageMode,
  });

  process.stderr.write(
    `Running ${tasks.length} fixture task(s), ${options.trials} trial(s) per task.\n`,
  );
  const report = await runAgentBenchmark({
    runId,
    tasks,
    trialsPerTask: options.trials,
    expectedTargetVersion: fixtureAgentTargetVersion({}, options.headless),
    budgets: {
      maxDurationMs: options.maxDurationMs,
      maxToolCalls: options.maxToolCalls,
      maxModelTurns: options.maxModelTurns,
    },
    targetFactory: createFixtureAgentTargetFactory({ headless: options.headless }),
    async agentFactory() {
      return createLangChainBrowserAgent({
        model: new ChatOpenAI({
          model: options.model,
          temperature: options.temperature,
          maxRetries: modelConfiguration.maxRetries,
          useResponsesApi: modelConfiguration.useResponsesApi,
        }),
        modelId: options.model,
        modelConfiguration,
        imageMode: options.imageMode,
      });
    },
  });
  await writeAgentBenchmarkArtifacts(outputDirectory, report);
  process.stdout.write(`${outputDirectory}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `BrowserIR agent benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

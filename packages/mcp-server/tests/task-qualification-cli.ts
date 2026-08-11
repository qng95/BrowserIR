import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { TASKS } from '@think-dom/fixture-app';

import {
  CLIENT_PROTOCOL_VERSION,
  type FixtureTaskQualificationResult,
} from './task-qualification-harness.js';
import {
  parseQualificationCliOptions,
  resolveQualificationOutputDirectory,
  writeQualificationArtifacts,
} from './task-qualification-report.js';
import {
  collectQualificationEnvironment,
  createQualificationReproducibilityMetadata,
  qualificationEnvironmentFailures,
} from './task-qualification-metadata.js';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workerPath = fileURLToPath(new URL('./task-qualification-worker.ts', import.meta.url));
const viteNodeCli = createRequire(import.meta.url).resolve('vite-node/cli');

const defaultRunId = (): string =>
  `qualification-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;

const failedWorkerResult = (
  task: (typeof TASKS)[number],
  processId: number,
  started: number,
  error: string,
): FixtureTaskQualificationResult => ({
  taskId: task.id,
  prompt: task.prompt,
  outcome: 'failed',
  passed: false,
  reason: 'The isolated qualification worker did not produce a task-oracle result.',
  plannerError: error,
  diagnostics: [],
  isolation: {
    processId,
    origin: 'unavailable',
    clientName: `browserir-qualification-${task.id}`,
    protocolVersion: CLIENT_PROTOCOL_VERSION,
  },
  durationMs: Math.round(performance.now() - started),
});

const runIsolatedTask = async (
  task: (typeof TASKS)[number],
): Promise<FixtureTaskQualificationResult> => {
  const started = performance.now();
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [viteNodeCli, workerPath, task.id], {
      cwd: workspaceRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      resolveResult(failedWorkerResult(task, child.pid ?? -1, started, error.message));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolveResult(failedWorkerResult(
          task,
          child.pid ?? -1,
          started,
          `Worker exited ${String(code)}: ${stderr.trim() || 'no diagnostic'}`,
        ));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as FixtureTaskQualificationResult;
        if (parsed.taskId !== task.id || typeof parsed.isolation?.processId !== 'number') {
          throw new Error('Worker returned malformed or mismatched qualification data.');
        }
        resolveResult(parsed);
      } catch (error) {
        resolveResult(failedWorkerResult(
          task,
          child.pid ?? -1,
          started,
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  });
};

async function main(): Promise<void> {
  const startedAtUtc = new Date().toISOString();
  const options = parseQualificationCliOptions(process.argv.slice(2));
  const runId = options.runId ?? defaultRunId();
  const results: FixtureTaskQualificationResult[] = [];
  for (const [index, task] of TASKS.entries()) {
    process.stderr.write(`[${index + 1}/${TASKS.length}] Qualifying ${task.id}...\n`);
    const result = await runIsolatedTask(task);
    results.push(result);
    process.stderr.write(`  ${result.outcome}: ${result.reason}\n`);
  }

  const outputDirectory = resolveQualificationOutputDirectory(
    workspaceRoot,
    options.outputDirectory,
    runId,
  );
  const environment = collectQualificationEnvironment(workspaceRoot, results);
  const reproducibility = createQualificationReproducibilityMetadata({
    startedAtUtc,
    completedAtUtc: new Date().toISOString(),
    environment,
  });
  await writeQualificationArtifacts(outputDirectory, runId, results, reproducibility);
  process.stdout.write(`${outputDirectory}\n`);

  const failures = results.filter((result) => result.outcome !== 'passed');
  const integrityFailures = qualificationEnvironmentFailures(
    environment,
    CLIENT_PROTOCOL_VERSION,
  );
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(
        `Release qualification failed: ${failure.taskId}: ${failure.reason}${
          failure.plannerError === undefined ? '' : ` (planner: ${failure.plannerError})`
        }\n`,
      );
    }
  }
  for (const failure of integrityFailures) {
    process.stderr.write(`Release qualification integrity failed: ${failure}\n`);
  }
  if (failures.length > 0 || integrityFailures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `BrowserIR task qualification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

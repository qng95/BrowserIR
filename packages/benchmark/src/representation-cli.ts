import { fileURLToPath } from 'node:url';

import { collectBenchmarkEnvironment } from './collect-environment.js';
import { environmentFingerprint } from './environment.js';
import {
  parseRepresentationCliOptions,
  resolveRepresentationOutputDirectory,
} from './representation-cli-options.js';
import {
  REPRESENTATION_SCENARIO_IDS,
  runRepresentationGroundTruthSuite,
  writeRepresentationArtifacts,
} from './representation-suite.js';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const options = parseRepresentationCliOptions(process.argv.slice(2));
  process.stderr.write('Collecting release environment...\n');
  const environment = await collectBenchmarkEnvironment(options.headless, {
    kind: 'representation-ground-truth',
    corpusVersion: '1.0.0',
    scenarioIds: REPRESENTATION_SCENARIO_IDS,
  });
  process.stderr.write('Running BrowserIR representation ground truth...\n');
  const result = await runRepresentationGroundTruthSuite({
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    headless: options.headless,
    environment,
    environmentFingerprint: environmentFingerprint(environment),
  });
  const outputDirectory = resolveRepresentationOutputDirectory(
    workspaceRoot,
    options.outputDirectory,
    result.report.runId,
  );
  await writeRepresentationArtifacts(outputDirectory, result);
  process.stdout.write(`${outputDirectory}\n`);
  if (!result.releaseReady) {
    for (const failure of result.releaseGate.failures) {
      process.stderr.write(`Release gate: ${failure}\n`);
    }
    for (const failed of result.report.tasks.filter(
      (task) => task.outcome === 'failed' && task.taskId !== 'release-gate/representation',
    )) {
      process.stderr.write(
        `Failed case ${failed.taskId}: ${failed.reason ?? 'No reason recorded.'}\n`,
      );
    }
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `BrowserIR representation benchmark failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});

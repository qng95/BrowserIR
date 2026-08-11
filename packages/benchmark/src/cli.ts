import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSERIR_OBSERVATION_TARGETS,
  BROWSERIR_OBSERVATION_METHODOLOGY,
  runBrowserIrObservationSuite,
} from './browserir-suite.js';
import {
  CUSTOMER_COUNT,
  DEFAULT_SEED,
  VEHICLE_COUNT,
} from '@think-dom/fixture-app';
import {
  parseBenchmarkCliOptions,
  resolveBenchmarkOutputDirectory,
} from './cli-options.js';
import { collectBenchmarkEnvironment } from './collect-environment.js';
import { stableJson } from './environment.js';
import {
  renderBenchmarkJson,
  renderBenchmarkMarkdown,
  renderSamplesNdjson,
} from './performance-report.js';
import { createBenchmarkSummary } from './summary.js';

const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const options = parseBenchmarkCliOptions(process.argv.slice(2));
  const knownTargets = new Map(
    BROWSERIR_OBSERVATION_TARGETS.map((target) => [target.id, target]),
  );
  const targets =
    options.targetIds.length === 0
      ? BROWSERIR_OBSERVATION_TARGETS
      : options.targetIds.map((id) => {
          const target = knownTargets.get(id);
          if (target === undefined) throw new Error(`Unknown benchmark target: ${id}.`);
          return target;
        });
  const runId = options.runId ?? `browserir-warm-observe-${timestamp()}`;
  const outputDirectory = resolveBenchmarkOutputDirectory(
    workspaceRoot,
    options.outputDirectory,
    runId,
  );
  await mkdir(outputDirectory, { recursive: true });

  process.stderr.write(
    'Collecting benchmark environment for warm steady-state observation ' +
      '(one navigate/settle per target; timing observe calls only)...\n',
  );
  const environment = await collectBenchmarkEnvironment(options.headless, {
    kind: 'browserir-observation',
    methodology: BROWSERIR_OBSERVATION_METHODOLOGY,
    warmups: options.warmups,
    samples: options.samples,
    maxCharacters: options.maxCharacters,
    targetIds: targets.map((target) => target.id),
    fixture: {
      seed: DEFAULT_SEED,
      customers: CUSTOMER_COUNT,
      vehicles: VEHICLE_COUNT,
      apiLatencyMs: 0,
      pageLatencyMs: 0,
    },
  });
  const results = await runBrowserIrObservationSuite({
    warmups: options.warmups,
    samples: options.samples,
    maxCharacters: options.maxCharacters,
    headless: options.headless,
    targets,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });
  const summary = createBenchmarkSummary(runId, environment, results);
  const writes = [
    ['environment.json', `${JSON.stringify(JSON.parse(stableJson(environment)), null, 2)}\n`],
    ['summary.json', renderBenchmarkJson(summary)],
    ['samples.ndjson', renderSamplesNdjson(results)],
    ['summary.md', renderBenchmarkMarkdown(summary)],
  ] as const;
  await Promise.all(
    writes.map(([name, contents]) =>
      writeFile(resolve(outputDirectory, name), contents, {
        encoding: 'utf8',
        flag: 'wx',
      }),
    ),
  );
  process.stdout.write(`${outputDirectory}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `BrowserIR benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

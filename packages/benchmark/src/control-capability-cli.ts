import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  assertInstalledRuntimeProvenanceStable,
  collectControlCapabilityRuntimeProvenance,
  createControlCapabilityReport,
  createFixtureAgentTargetFactory,
  createPlaywrightMcpToolBroker,
  fixtureAgentTargetVersion,
  fixtureAgentTasks,
  inspectModelFacingCatalog,
  PLAYWRIGHT_MCP_VERSION,
  readControlCapabilityProtocol,
  renderInstalledRuntimeProvenance,
  runAgentBenchmark,
  writeControlCapabilityArtifacts,
  type AgentBenchmarkOptions,
  type AgentBenchmarkTask,
  type ControlCapabilityProtocol,
  type FixtureAgentToolBrokerFactoryInput,
} from './agent-benchmark/index.js';
import {
  assertControlCapabilityProviderReady,
  createControlCapabilityAgentFactory,
} from './control-capability-agent.js';
import {
  verifyOllamaControlModelBinding,
  verifyOpenRouterControlModelBinding,
} from './control-capability-model-metadata.js';
import {
  CONTROL_CAPABILITY_CLI_USAGE,
  parseControlCapabilityCliOptions,
  resolveControlCapabilityOutputDirectory,
} from './control-capability-cli-options.js';
import { stableJson } from './environment.js';

const execFile = promisify(execFileCallback);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const prettyStableJson = (value: unknown): string =>
  `${JSON.stringify(JSON.parse(stableJson(value)) as unknown, null, 2)}\n`;

export function controlCapabilityModelMetadataArtifacts(
  start: unknown,
  end: unknown,
): Readonly<Record<string, string>> {
  return {
    'model-metadata-start.json': prettyStableJson(start),
    'model-metadata-end.json': prettyStableJson(end),
  };
}

const verifyControlCapabilityModelBinding = (protocol: ControlCapabilityProtocol) =>
  protocol.agent.provider === 'openrouter'
    ? verifyOpenRouterControlModelBinding({ binding: protocol.agent })
    : verifyOllamaControlModelBinding({ binding: protocol.agent });

export interface ControlCapabilityOutputReservation {
  readonly outputDirectory: string;
}

/** Atomically claims a new output directory before any paid or browser work begins. */
export async function reserveControlCapabilityOutput(
  path: string,
): Promise<ControlCapabilityOutputReservation> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Control capability output is already reserved: ${path}`);
    }
    throw error;
  }
  return Object.freeze({ outputDirectory: path });
}

/** Runs work only after atomically claiming its evidence path; failures retain the claim. */
export async function runWithControlCapabilityOutputReservation<T>(
  path: string,
  work: (reservation: ControlCapabilityOutputReservation) => Promise<T>,
): Promise<T> {
  const reservation = await reserveControlCapabilityOutput(path);
  return work(reservation);
}

export interface ControlCapabilitySourceSnapshot {
  revision: string | null;
  tree: string | null;
  clean: boolean;
}

export function assertControlCapabilitySourceStable(
  start: ControlCapabilitySourceSnapshot,
  end: ControlCapabilitySourceSnapshot,
): void {
  if (!start.clean || !end.clean) {
    throw new Error('Control capability evidence requires a clean source tree throughout.');
  }
  if (start.revision === null || start.tree === null || end.revision === null || end.tree === null) {
    throw new Error('Control capability source revision and tree must be available.');
  }
  if (start.revision !== end.revision) {
    throw new Error('Control capability source revision drifted during the run.');
  }
  if (start.tree !== end.tree) {
    throw new Error('Control capability source tree drifted during the run.');
  }
}

async function captureControlCapabilitySource(
  root: string,
): Promise<ControlCapabilitySourceSnapshot> {
  const git = async (...args: string[]): Promise<string> =>
    (await execFile('git', args, { cwd: root })).stdout;
  const [status, revision, tree] = await Promise.all([
    git('status', '--porcelain=v1', '--untracked-files=all'),
    git('rev-parse', 'HEAD'),
    git('rev-parse', 'HEAD^{tree}'),
  ]);
  return {
    revision: revision.trimEnd() || null,
    tree: tree.trimEnd() || null,
    clean: status.length === 0,
  };
}

async function assertCommittedProtocol(input: {
  workspaceRoot: string;
  manifestPath: string;
  sourceText: string;
  revision: string | null;
}): Promise<void> {
  if (input.revision === null) {
    throw new Error('Control capability protocol cannot bind without a Git revision.');
  }
  const manifestRelativePath = relative(input.workspaceRoot, input.manifestPath);
  if (
    manifestRelativePath.length === 0 ||
    manifestRelativePath.startsWith('..') ||
    isAbsolute(manifestRelativePath)
  ) {
    throw new Error('Control capability protocol must be inside the workspace.');
  }
  const committed = (
    await execFile('git', ['show', `${input.revision}:${manifestRelativePath}`], {
      cwd: input.workspaceRoot,
    })
  ).stdout;
  if (committed !== input.sourceText) {
    throw new Error('Control capability protocol differs from the committed source bytes.');
  }
}

export function createControlCapabilityBenchmarkOptions(input: {
  runId: string;
  protocol: ControlCapabilityProtocol;
  task: AgentBenchmarkTask;
  targetFactory: AgentBenchmarkOptions['targetFactory'];
  agentFactory: AgentBenchmarkOptions['agentFactory'];
}): AgentBenchmarkOptions {
  return {
    runId: input.runId,
    tasks: [input.task],
    trialsPerTask: input.protocol.schedule.attempts,
    expectedTargetVersion: input.protocol.target.expectedVersion,
    expectedToolCatalogSha256: input.protocol.control.expectedToolCatalogSha256,
    budgets: { ...input.protocol.budgets },
    targetFactory: input.targetFactory,
    agentFactory: input.agentFactory,
  };
}

const controlTargetFactory = ({
  origin,
  headless,
  browserProfile,
}: FixtureAgentToolBrokerFactoryInput) =>
  createPlaywrightMcpToolBroker({
    allowedOrigin: origin,
    headless,
    viewport: browserProfile.viewport,
    locale: browserProfile.locale,
    timezoneId: browserProfile.timezoneId,
    colorScheme: browserProfile.colorScheme,
    reducedMotion: browserProfile.reducedMotion,
  });

function assertRuntimeContract(input: {
  protocol: ControlCapabilityProtocol;
  task: AgentBenchmarkTask;
  catalog: Awaited<ReturnType<typeof inspectModelFacingCatalog>>;
}): void {
  const { protocol, task, catalog } = input;
  if (protocol.control.interfaceVersion !== PLAYWRIGHT_MCP_VERSION) {
    throw new Error('Official Playwright MCP version drifted from the protocol.');
  }
  if (protocol.target.expectedVersion !== fixtureAgentTargetVersion({}, protocol.target.headless)) {
    throw new Error('Fixture target version drifted from the control capability protocol.');
  }
  if (task.id !== protocol.task.id || task.version !== protocol.task.version) {
    throw new Error('Fixture task identity drifted from the control capability protocol.');
  }
  if (sha256(task.prompt) !== protocol.task.promptSha256) {
    throw new Error('Fixture task prompt drifted from the control capability protocol.');
  }
  if (catalog.targetVersion !== protocol.target.expectedVersion) {
    throw new Error('Control preflight target version drifted from the protocol.');
  }
  if (catalog.baseline.oracleVersion !== protocol.task.oracleVersion) {
    throw new Error('Fixture task oracle drifted from the control capability protocol.');
  }
  if (catalog.sha256 !== protocol.control.expectedToolCatalogSha256) {
    throw new Error('Official Playwright MCP tool catalog drifted from the protocol.');
  }
}

export async function runControlCapabilityCli(
  args: readonly string[],
  root = workspaceRoot,
): Promise<string> {
  const cli = parseControlCapabilityCliOptions(args);
  const manifestPath = resolve(root, cli.protocolPath);
  const { protocol, sourceText, sha256: protocolSha256 } =
    await readControlCapabilityProtocol(manifestPath);
  const runId = `${protocol.protocolId}-${timestamp()}`;
  const outputDirectory = resolveControlCapabilityOutputDirectory(
    root,
    cli.outputDirectory,
    runId,
  );

  const sourceStart = await captureControlCapabilitySource(root);
  if (!sourceStart.clean) {
    throw new Error('Control capability evidence requires a clean Git worktree.');
  }
  await assertCommittedProtocol({
    workspaceRoot: root,
    manifestPath,
    sourceText,
    revision: sourceStart.revision,
  });
  return runWithControlCapabilityOutputReservation(outputDirectory, async () => {
    assertControlCapabilityProviderReady(protocol.agent);
    const runtimeProvenance = await collectControlCapabilityRuntimeProvenance();
    const modelMetadata = await verifyControlCapabilityModelBinding(protocol);

    const [task] = fixtureAgentTasks([protocol.task.id]);
    if (task === undefined) throw new Error(`Unknown fixture task: ${protocol.task.id}.`);
    const targetFactory = createFixtureAgentTargetFactory({
      headless: protocol.target.headless,
      toolBrokerFactory: controlTargetFactory,
    });
    const catalog = await inspectModelFacingCatalog({ task, targetFactory });
    assertRuntimeContract({ protocol, task, catalog });

    const agentFactory = createControlCapabilityAgentFactory({
      modelSeedBase: protocol.schedule.modelSeedBase,
      agent: protocol.agent,
    });
    const benchmark = await runAgentBenchmark(
      createControlCapabilityBenchmarkOptions({
        runId,
        protocol,
        task,
        targetFactory,
        agentFactory,
      }),
    );

    const modelMetadataEnd = await verifyControlCapabilityModelBinding(protocol);
    if (stableJson(modelMetadataEnd) !== stableJson(modelMetadata)) {
      throw new Error('Control capability model metadata drifted during the run.');
    }
    const runtimeProvenanceEnd = await collectControlCapabilityRuntimeProvenance();
    assertInstalledRuntimeProvenanceStable(runtimeProvenance, runtimeProvenanceEnd);
    const sourceEnd = await captureControlCapabilitySource(root);
    assertControlCapabilitySourceStable(sourceStart, sourceEnd);
    const report = createControlCapabilityReport({
      runId,
      protocol,
      protocolSha256,
      attempts: benchmark.trials,
    });
    await writeControlCapabilityArtifacts(outputDirectory, report, {
      'control-tool-catalog.json': prettyStableJson(catalog.catalog),
      ...controlCapabilityModelMetadataArtifacts(modelMetadata, modelMetadataEnd),
      'protocol.json': sourceText,
      'runtime-provenance-end.json': renderInstalledRuntimeProvenance(runtimeProvenanceEnd),
      'runtime-provenance-start.json': renderInstalledRuntimeProvenance(runtimeProvenance),
      'source-end.json': prettyStableJson(sourceEnd),
      'source-start.json': prettyStableJson(sourceStart),
      'system-prompt.txt': `${protocol.agent.systemPrompt}\n`,
    });
    return outputDirectory;
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(CONTROL_CAPABILITY_CLI_USAGE);
    return;
  }
  const outputDirectory = await runControlCapabilityCli(args);
  process.stdout.write(`${outputDirectory}\n`);
}

// vite-node keeps its own executable in argv[1], so a path-equality entrypoint
// check is not reliable. Vitest sets VITEST while importing the pure helpers.
if (process.env['VITEST'] !== 'true') {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Control capability qualification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatOpenAI } from '@langchain/openai';
import { BROWSERIR_PROTOCOL_VERSION, BROWSERIR_VERSION } from '@browserir/mcp';

import { stableJson } from './environment.js';
import {
  capturePairedExecutionEnvironmentEnd,
  createPairedAgentBenchmarkCompletionMarker,
  createFixtureAgentTargetFactory,
  createPairedDevelopmentJournal,
  createLangChainBrowserAgent,
  createPlaywrightMcpToolBroker,
  fixtureAgentTargetVersion,
  fixtureAgentTasks,
  inspectModelFacingCatalog,
  PLAYWRIGHT_MCP_VERSION,
  preparePairedExecutionEnvironmentStart,
  readPairedAgentBenchmarkCompletionMarker,
  readEvidenceDropProtocol,
  readPairedDevelopmentJournal,
  resumePairedDevelopmentJournal,
  runPairedAgentBenchmark,
  writePairedAgentBenchmarkArtifacts,
  type AgentBenchmarkArm,
  type EvidenceDropProtocol,
  type FixtureAgentToolBrokerFactoryInput,
  type ModelFacingCatalogSnapshot,
  type PreparedPairedExecutionEnvironmentStart,
} from './agent-benchmark/index.js';
import {
  PAIRED_UPLIFT_CLI_USAGE,
  parsePairedUpliftCliOptions,
  resolvePairedUpliftOutputDirectory,
} from './uplift-cli-options.js';
import {
  assertPairedUpliftSourceBinding,
  classifyPairedUpliftResume,
  type PairedUpliftResumeMode,
} from './uplift-cli-lifecycle.js';

const execFile = promisify(execFileCallback);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const browserIrInterfaceVersion = (): string =>
  `${BROWSERIR_VERSION}+mcp-${BROWSERIR_PROTOCOL_VERSION}`;

const prettyStableJson = (value: unknown): string =>
  `${JSON.stringify(JSON.parse(stableJson(value)) as unknown, null, 2)}\n`;

async function sourceState(input: {
  phase: EvidenceDropProtocol['phase'];
  freezeRef?: string | undefined;
  manifestPath: string;
  manifestSource: string;
}): Promise<{
  revision: string | null;
  tree: string | null;
  clean: boolean;
  freezeRef?: string | undefined;
}> {
  const gitRaw = async (...args: string[]): Promise<string> =>
    (await execFile('git', args, { cwd: workspaceRoot })).stdout;
  const git = async (...args: string[]): Promise<string> =>
    (await gitRaw(...args)).trimEnd();
  let revision: string | null = null;
  let tree: string | null = null;
  const status = await gitRaw('status', '--porcelain=v1', '--untracked-files=all');
  try {
    [revision, tree] = await Promise.all([
      git('rev-parse', 'HEAD'),
      git('rev-parse', 'HEAD^{tree}'),
    ]);
  } catch (error) {
    if (input.phase === 'sealed') throw error;
  }
  const clean = status.length === 0;
  if (input.phase === 'sealed') {
    if (input.freezeRef === undefined) {
      throw new Error('Sealed protocol is missing its freezeRef.');
    }
    if (!clean) throw new Error('Sealed evidence requires a clean Git worktree.');
    const frozenRevision = await git('rev-parse', `${input.freezeRef}^{commit}`);
    const manifestRelativePath = relative(workspaceRoot, input.manifestPath);
    if (
      manifestRelativePath.startsWith('..') ||
      isAbsolute(manifestRelativePath) ||
      manifestRelativePath.length === 0
    ) {
      throw new Error('Sealed protocol manifest must be inside the workspace.');
    }
    const committedSource = await gitRaw('show', `HEAD:${manifestRelativePath}`);
    assertPairedUpliftSourceBinding({
      phase: input.phase,
      freezeRef: input.freezeRef,
      clean,
      revision,
      tree,
      frozenRevision,
      manifestRelativePath,
      manifestSource: input.manifestSource,
      committedManifestSource: committedSource,
    });
  }
  return {
    revision,
    tree,
    clean,
    ...(input.freezeRef === undefined ? {} : { freezeRef: input.freezeRef }),
  };
}

async function verifyOllamaModel(protocol: EvidenceDropProtocol): Promise<void> {
  if (protocol.agent.provider !== 'ollama') return;
  const tagsUrl = new URL('/api/tags', protocol.agent.baseUrl);
  const response = await fetch(tagsUrl);
  if (!response.ok) {
    throw new Error(`Ollama model preflight failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    models?: Array<{ name?: string; digest?: string; capabilities?: string[] }>;
  };
  const model = body.models?.find((candidate) => candidate.name === protocol.agent.modelId);
  if (model?.digest === undefined) {
    throw new Error(`Ollama model is not installed: ${protocol.agent.modelId}`);
  }
  if (`sha256:${model.digest}` !== protocol.agent.modelDigest) {
    throw new Error(
      `Ollama model digest drift: expected ${protocol.agent.modelDigest}, received sha256:${model.digest}.`,
    );
  }
  if (model.capabilities !== undefined && !model.capabilities.includes('tools')) {
    throw new Error(`Ollama model lacks structured tool-call support: ${protocol.agent.modelId}`);
  }
  if (protocol.agent.contextWindowTokens !== undefined) {
    const showResponse = await fetch(new URL('/api/show', protocol.agent.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: protocol.agent.modelId }),
    });
    if (!showResponse.ok) {
      throw new Error(`Ollama context preflight failed with HTTP ${showResponse.status}.`);
    }
    const show = (await showResponse.json()) as { parameters?: string };
    const configuredContext = show.parameters
      ?.split('\n')
      .map((line) => line.trim().split(/\s+/u))
      .find(([name]) => name === 'num_ctx')?.[1];
    if (Number(configuredContext) !== protocol.agent.contextWindowTokens) {
      throw new Error(
        `Ollama context drift: expected ${protocol.agent.contextWindowTokens}, received ${configuredContext ?? 'unset'}.`,
      );
    }
  }
}

function modelFor(protocol: EvidenceDropProtocol): ChatOpenAI {
  if (protocol.agent.provider === 'openai') {
    if (process.env['OPENAI_API_KEY'] === undefined) {
      throw new Error('OPENAI_API_KEY is required by the selected protocol.');
    }
    return new ChatOpenAI({
      model: protocol.agent.modelId,
      temperature: protocol.agent.temperature,
      maxRetries: protocol.agent.maxRetries,
      useResponsesApi: false,
    });
  }
  return new ChatOpenAI({
    model: protocol.agent.modelId,
    temperature: protocol.agent.temperature,
    maxRetries: protocol.agent.maxRetries,
    useResponsesApi: false,
    apiKey: 'ollama-local-no-secret',
    configuration: { baseURL: protocol.agent.baseUrl },
  });
}

function assertRuntimeVersions(protocol: EvidenceDropProtocol): void {
  if (protocol.target.expectedVersion !== fixtureAgentTargetVersion({}, protocol.target.headless)) {
    throw new Error('Fixture target version drifted from the protocol.');
  }
  if (protocol.arms.control.interfaceVersion !== PLAYWRIGHT_MCP_VERSION) {
    throw new Error('Official Playwright MCP version drifted from the protocol.');
  }
  if (protocol.arms.treatment.interfaceVersion !== browserIrInterfaceVersion()) {
    throw new Error('BrowserIR interface version drifted from the protocol.');
  }
  if (protocol.phase === 'sealed' && protocol.agent.provider === 'openai') {
    throw new Error(
      'This alpha runner cannot yet verify an OpenAI model artifact for sealed evidence.',
    );
  }
}

function assertTaskContracts(
  protocol: EvidenceDropProtocol,
  tasks: ReturnType<typeof fixtureAgentTasks>,
  snapshots: readonly ModelFacingCatalogSnapshot[],
): void {
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    const contract = protocol.taskContracts[index]!;
    if (task.id !== contract.id || task.version !== contract.version) {
      throw new Error(`Fixture task version drifted for ${task.id}.`);
    }
    if (sha256(task.prompt) !== contract.promptSha256) {
      throw new Error(`Fixture task prompt drifted for ${task.id}.`);
    }
  }
  const expectedOracle = protocol.taskContracts[0]!.oracleVersion;
  for (const snapshot of snapshots) {
    if (snapshot.baseline.oracleVersion !== expectedOracle) {
      throw new Error('Fixture oracle version drifted from the protocol.');
    }
  }
}

const controlBrokerFactory = ({
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

const resumeStatus = (mode: PairedUpliftResumeMode | undefined): string =>
  mode === undefined ? 'Running' : mode === 'finalize_only' ? 'Finalizing' : 'Resuming';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(PAIRED_UPLIFT_CLI_USAGE);
    return;
  }
  const cli = parsePairedUpliftCliOptions(args);
  const manifestPath = resolve(workspaceRoot, cli.protocolPath);
  const { protocol, sourceText, sha256: protocolSha256 } =
    await readEvidenceDropProtocol(manifestPath);
  const generatedRunId = `drop-${protocol.dropId}-${protocol.phase}-${timestamp()}`;
  const outputDirectory = resolvePairedUpliftOutputDirectory(
    workspaceRoot,
    cli.resumeDirectory ?? cli.outputDirectory,
    generatedRunId,
  );
  const retainedBeforeResume =
    cli.resumeDirectory === undefined
      ? undefined
      : await readPairedDevelopmentJournal(join(outputDirectory, 'journal'));
  const completionBeforeResume =
    retainedBeforeResume === undefined
      ? undefined
      : await readPairedAgentBenchmarkCompletionMarker(outputDirectory);
  const resumeDisposition =
    retainedBeforeResume === undefined
      ? undefined
      : classifyPairedUpliftResume({
          retained: retainedBeforeResume,
          ...(completionBeforeResume === undefined
            ? {}
            : { completion: completionBeforeResume }),
          protocolId: protocol.protocolId,
          protocolSha256,
        });
  const runId = resumeDisposition?.runId ?? generatedRunId;
  assertRuntimeVersions(protocol);
  await verifyOllamaModel(protocol);
  const source = await sourceState({
    phase: protocol.phase,
    freezeRef: protocol.freezeRef,
    manifestPath,
    manifestSource: sourceText,
  });
  const tasks = fixtureAgentTasks(protocol.taskIds);
  const controlTargetFactory = createFixtureAgentTargetFactory({
    headless: protocol.target.headless,
    toolBrokerFactory: controlBrokerFactory,
  });
  const treatmentTargetFactory = createFixtureAgentTargetFactory({
    headless: protocol.target.headless,
  });
  const [controlCatalog, treatmentCatalog] = await Promise.all([
    inspectModelFacingCatalog({ task: tasks[0]!, targetFactory: controlTargetFactory }),
    inspectModelFacingCatalog({ task: tasks[0]!, targetFactory: treatmentTargetFactory }),
  ]);
  assertTaskContracts(protocol, tasks, [controlCatalog, treatmentCatalog]);
  if (controlCatalog.baseline.stateFingerprint !== treatmentCatalog.baseline.stateFingerprint) {
    throw new Error('Control and treatment preflights started from different database state.');
  }
  for (const [role, snapshot] of [
    ['control', controlCatalog],
    ['treatment', treatmentCatalog],
  ] as const) {
    if (snapshot.targetVersion !== protocol.target.expectedVersion) {
      throw new Error(`${role} target version drifted from the protocol.`);
    }
    const expected = protocol.arms[role].expectedToolCatalogSha256;
    if (expected !== undefined && expected !== snapshot.sha256) {
      throw new Error(
        `${role} model-facing tool catalog drift: expected ${expected}, received ${snapshot.sha256}.`,
      );
    }
  }

  const executionStart = {
    schemaVersion: '1.0.0',
    stage: 'started',
    runId,
    protocolId: protocol.protocolId,
    protocolSha256,
    source,
    toolCatalogs: {
      control: { sha256: controlCatalog.sha256, toolCount: controlCatalog.toolCount },
      treatment: {
        sha256: treatmentCatalog.sha256,
        toolCount: treatmentCatalog.toolCount,
      },
    },
  } as const;
  const preflightArtifacts = {
    'protocol.json': sourceText,
    'system-prompt.txt': protocol.agent.systemPrompt,
    'control-tool-catalog.json': prettyStableJson(controlCatalog.catalog),
    'treatment-tool-catalog.json': prettyStableJson(treatmentCatalog.catalog),
    'execution-start.json': prettyStableJson(executionStart),
  } as const;
  const journalDirectory = join(outputDirectory, 'journal');
  let journal;
  let resume;
  let environmentStart: PreparedPairedExecutionEnvironmentStart;
  const environmentCollectionOptions = { workspaceRoot, protocol } as const;
  if (retainedBeforeResume === undefined) {
    await mkdir(dirname(outputDirectory), { recursive: true });
    await mkdir(outputDirectory);
    for (const [name, content] of Object.entries(preflightArtifacts)) {
      await writeFile(join(outputDirectory, name), content, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
    environmentStart = await preparePairedExecutionEnvironmentStart({
      outputDirectory,
      mode: 'create',
      collectionOptions: environmentCollectionOptions,
    });
    journal = await createPairedDevelopmentJournal(journalDirectory);
  } else {
    for (const [name, content] of Object.entries(preflightArtifacts)) {
      let existing: string;
      try {
        existing = await readFile(join(outputDirectory, name), 'utf8');
      } catch (error) {
        throw new Error(
          `Cannot resume without preflight artifact ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (existing !== content) {
        throw new Error(`Resume preflight differs from retained evidence: ${name}`);
      }
    }
    // Verify the immutable start snapshot against live runtime metadata before
    // reopening the journal or allowing a benchmark attempt to start.
    environmentStart = await preparePairedExecutionEnvironmentStart({
      outputDirectory,
      mode: 'resume',
      collectionOptions: environmentCollectionOptions,
    });
    const recovery = await resumePairedDevelopmentJournal(journalDirectory);
    journal = recovery.journal;
    resume = recovery.state;
  }
  const modelConfiguration = Object.freeze({
    provider: protocol.agent.provider,
    modelDigest: protocol.agent.modelDigest,
    contextWindowTokens: protocol.agent.contextWindowTokens,
    temperature: protocol.agent.temperature,
    maxRetries: protocol.agent.maxRetries,
    useResponsesApi: false,
    imageMode: protocol.agent.imageMode,
  });
  const agentFactory: AgentBenchmarkArm['agentFactory'] = async () =>
    createLangChainBrowserAgent({
      model: modelFor(protocol),
      modelId: protocol.agent.modelId,
      adapterId: 'shared-langchain-agent',
      modelConfiguration,
      systemPrompt: protocol.agent.systemPrompt,
      imageMode: protocol.agent.imageMode,
    });

  process.stderr.write(
    `${resumeStatus(resumeDisposition?.mode)} ${protocol.trialsPerTask} matched ${protocol.phase} block(s) for ${tasks.map((task) => task.id).join(', ')}.\n`,
  );
  const report = await runPairedAgentBenchmark({
    runId,
    protocolId: protocol.protocolId,
    protocolSha256,
    protocolBinding: 'development',
    phase: protocol.phase,
    scheduleSeed: protocol.schedule.orderSeed,
    bootstrapSeed: protocol.schedule.bootstrapSeed,
    bootstrapResamples: protocol.schedule.bootstrapResamples,
    intervalMethod: protocol.analysis.interval,
    tasks,
    trialsPerTask: protocol.trialsPerTask,
    expectedTargetVersion: protocol.target.expectedVersion,
    budgets: protocol.budgets,
    arms: [
      {
        ...protocol.arms.control,
        expectedToolCatalogSha256: controlCatalog.sha256,
        targetFactory: controlTargetFactory,
        agentFactory,
      },
      {
        ...protocol.arms.treatment,
        expectedToolCatalogSha256: treatmentCatalog.sha256,
        targetFactory: treatmentTargetFactory,
        agentFactory,
      },
    ],
    eventSink: journal.append,
    ...(resume === undefined ? {} : { resume }),
  });
  if (protocol.phase === 'development') {
    for (const block of report.blocks) {
      for (const role of ['control', 'treatment'] as const) {
        const attempt = block.attempts[role];
        if (attempt.agentError !== undefined) {
          process.stderr.write(
            `[development diagnostic] ${block.taskId}/${role}: ${attempt.agentError}\n`,
          );
        }
      }
    }
  }
  const retainedJournal = await readPairedDevelopmentJournal(journalDirectory);
  if (!retainedJournal.complete) {
    throw new Error('Development journal did not retain the completed schedule.');
  }
  const finalJournalEventSha256 = retainedJournal.events.at(-1)?.eventSha256;
  if (finalJournalEventSha256 === undefined) {
    throw new Error('Completed development journal has no final event digest.');
  }
  // This recapture happens only after the durable run_completed event exists.
  const environmentEnd = await capturePairedExecutionEnvironmentEnd({
    start: environmentStart.snapshot,
    collectionOptions: environmentCollectionOptions,
    journalFinalEventSha256: finalJournalEventSha256,
  });
  const journalNdjson = `${retainedJournal.events
    .map((event) => stableJson(event))
    .join('\n')}\n`;
  const execution = {
    schemaVersion: '1.0.0',
    stage: 'completed',
    runId,
    protocolId: protocol.protocolId,
    protocolSha256,
    source,
    toolCatalogs: {
      control: { sha256: controlCatalog.sha256, toolCount: controlCatalog.toolCount },
      treatment: {
        sha256: treatmentCatalog.sha256,
        toolCount: treatmentCatalog.toolCount,
      },
    },
    journal: {
      schemaVersion: retainedJournal.events[0]?.schemaVersion,
      events: retainedJournal.events.length,
      finalEventSha256: finalJournalEventSha256,
      complete: retainedJournal.complete,
    },
    environment: environmentEnd.binding,
  };
  await writePairedAgentBenchmarkArtifacts(outputDirectory, report, {
    ...preflightArtifacts,
    'environment-start.json': environmentEnd.renderedStart,
    'environment-end.json': environmentEnd.renderedEnd,
    'execution.json': prettyStableJson(execution),
    'journal.ndjson': journalNdjson,
  });
  await createPairedAgentBenchmarkCompletionMarker(outputDirectory, {
    runId,
    protocolId: protocol.protocolId,
    protocolSha256,
    journalFinalEventSha256: finalJournalEventSha256,
  });
  process.stdout.write(`${outputDirectory}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `BrowserIR paired uplift benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
